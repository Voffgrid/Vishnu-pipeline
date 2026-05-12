import { inngest } from "@/inngest/client";
import { openai, SCRIPT_MODEL } from "@/lib/openai";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { computeTextCost, logApiCall } from "@/lib/cost";

// ─── Schema for structured output ────────────────────────────────────────────

const SCENE_JSON_SCHEMA = {
  type: "object",
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scene_number:     { type: "integer" },
          start_time:       { type: "integer" },
          end_time:         { type: "integer" },
          voiceover_text:   { type: "string"  },
          on_screen_action: { type: "string"  },
          visual_keywords:  { type: "array", items: { type: "string" } },
        },
        required: [
          "scene_number", "start_time", "end_time",
          "voiceover_text", "on_screen_action", "visual_keywords",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["scenes"],
  additionalProperties: false,
} as const;

type Scene = {
  scene_number:     number;
  start_time:       number;
  end_time:         number;
  voiceover_text:   string;
  on_screen_action: string;
  visual_keywords:  string[];
};

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a video director's assistant. Convert a script into N scenes, \
each exactly 8 seconds long. The total scenes × 8 must equal the target duration. \
Each scene must contain: scene_number, start_time, end_time, voiceover_text \
(what the narrator says during this scene), on_screen_action (what the camera sees), \
and visual_keywords (3–6 tokens for style continuity).`;

function buildUserPrompt(
  script: string,
  durationSeconds: number,
  styleGuide: string | null,
  strict = false
): string {
  const n = durationSeconds / 8;
  const lines = [
    `Script: """${script}"""`,
    `Target duration: ${durationSeconds}s`,
    `Number of scenes: ${n}`,
    `Style guide: ${styleGuide ?? "none"}`,
  ];
  if (strict) {
    lines.push(`\nCRITICAL: You MUST return exactly ${n} scenes. No more, no fewer.`);
  }
  return lines.join("\n");
}

// ─── OpenAI Responses API call ───────────────────────────────────────────────

async function callOpenAI(
  script: string,
  durationSeconds: number,
  styleGuide: string | null,
  strict = false
): Promise<{ scenes: Scene[]; inputTokens: number; outputTokens: number }> {
  const response = await openai.responses.create({
    model: SCRIPT_MODEL,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: buildUserPrompt(script, durationSeconds, styleGuide, strict) },
    ],
    text: {
      format: {
        type:   "json_schema",
        name:   "scene_breakdown",
        strict: true,
        schema: SCENE_JSON_SCHEMA,
      },
    },
  });

  const parsed = JSON.parse(response.output_text) as { scenes: Scene[] };

  return {
    scenes:       parsed.scenes,
    inputTokens:  response.usage?.input_tokens  ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

// ─── Inngest function ─────────────────────────────────────────────────────────

export const runStage1Script = inngest.createFunction(
  {
    id: "stage-1-script",
    triggers: [{ event: "job/stage-1-start" }],
    retries: 2,
  },
  async ({ event, step }) => {
    const { jobId } = event.data as { jobId: string };

    // ── Step 1: fetch the job row ───────────────────────────────────────────
    const job = await step.run("fetch-job", async () => {
      const sb = getSupabaseAdminClient();
      const { data, error } = await sb
        .from("jobs")
        .select("script, duration_seconds, style_guide, auto_mode")
        .eq("id", jobId)
        .single();
      if (error || !data) throw new Error(`Job not found: ${error?.message}`);
      return data as {
        script:           string;
        duration_seconds: number;
        style_guide:      string | null;
        auto_mode:        boolean;
      };
    });

    // ── Step 2: call OpenAI Responses API with structured output ────────────
    const openaiResult = await step.run("call-openai", async () => {
      const expectedCount = job.duration_seconds / 8;
      const startMs = Date.now();

      let result = await callOpenAI(job.script, job.duration_seconds, job.style_guide);

      // Auto-retry once with a stricter prompt if scene count is wrong.
      if (result.scenes.length !== expectedCount) {
        result = await callOpenAI(
          job.script, job.duration_seconds, job.style_guide, true
        );
      }

      if (result.scenes.length !== expectedCount) {
        throw new Error(
          `Expected ${expectedCount} scenes, got ${result.scenes.length}`
        );
      }

      const durationMs = Date.now() - startMs;
      const costUsd = computeTextCost(result.inputTokens, result.outputTokens);

      await logApiCall({
        jobId,
        provider:        "openai",
        model:           SCRIPT_MODEL,
        operation:       "script",
        costUsd,
        durationMs,
        requestPayload:  { script_length: job.script.length, duration: job.duration_seconds },
        responsePayload: { scene_count: result.scenes.length },
        status:          "success",
      });

      return { scenes: result.scenes, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd };
    });

    // ── Step 3: insert one row per scene ────────────────────────────────────
    await step.run("insert-scenes", async () => {
      const sb = getSupabaseAdminClient();
      const rows = openaiResult.scenes.map((s: Scene) => ({
        job_id:           jobId,
        scene_number:     s.scene_number,
        start_time:       s.start_time,
        end_time:         s.end_time,
        voiceover_text:   s.voiceover_text,
        on_screen_action: s.on_screen_action,
        visual_keywords:  s.visual_keywords,
        status:           "pending",
      }));

      const { error } = await sb.from("scenes").insert(rows);
      if (error) throw new Error(`Failed to insert scenes: ${error.message}`);
    });

    // ── Step 4: update job status ────────────────────────────────────────────
    const nextStatus = await step.run("update-job-status", async () => {
      const sb = getSupabaseAdminClient();
      const status = job.auto_mode ? "prompting" : "awaiting_script_approval";

      const { error } = await sb
        .from("jobs")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", jobId);
      if (error) throw new Error(`Failed to update job status: ${error.message}`);

      return status;
    });

    // ── Step 5: trigger Stage 2 (auto mode only) ────────────────────────────
    if (nextStatus === "prompting") {
      await step.sendEvent("trigger-stage-2", {
        name: "job/stage-2-needed",
        data: { jobId },
      });
    }

    return {
      jobId,
      sceneCount:   openaiResult.scenes.length,
      inputTokens:  openaiResult.inputTokens,
      outputTokens: openaiResult.outputTokens,
      costUsd:      openaiResult.costUsd,
      nextStatus,
    };
  }
);
