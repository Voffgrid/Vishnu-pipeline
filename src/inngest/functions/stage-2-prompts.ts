import { inngest } from "@/inngest/client";
import { openai, SCRIPT_MODEL } from "@/lib/openai";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { computeTextCost, logApiCall } from "@/lib/cost";

// ─── Schema for structured output ────────────────────────────────────────────

const PROMPT_JSON_SCHEMA = {
  type: "object",
  properties: {
    style_anchor: { type: "string" },
    prompts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scene_number: { type: "integer" },
          image_prompt: { type: "string" },
        },
        required: ["scene_number", "image_prompt"],
        additionalProperties: false,
      },
    },
  },
  required: ["style_anchor", "prompts"],
  additionalProperties: false,
} as const;

type SceneInput = {
  scene_number:     number;
  voiceover_text:   string;
  on_screen_action: string;
  visual_keywords:  string[];
};

type PromptResult = {
  style_anchor: string;
  prompts: { scene_number: number; image_prompt: string }[];
};

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a visual prompt engineer for AI image generation. \
Given a set of video scenes, write one detailed cinematic image prompt per scene \
and a global style_anchor paragraph (2–4 sentences) that pins the lighting, color palette, \
lens character, and broad subject treatment across ALL scenes for visual consistency. \
Each image_prompt should be 1–3 sentences describing the specific frame composition \
and subject for that scene only.`;

function buildUserPrompt(
  scenes: SceneInput[],
  styleGuide: string | null
): string {
  const sceneLines = scenes.map((s) =>
    `Scene ${s.scene_number}:\n` +
    `  Action: ${s.on_screen_action}\n` +
    `  Voiceover: ${s.voiceover_text}\n` +
    `  Keywords: ${s.visual_keywords.join(", ")}`
  );
  return [
    styleGuide ? `Style guide: ${styleGuide}\n` : "",
    `Scenes:\n${sceneLines.join("\n\n")}`,
    `\nReturn exactly ${scenes.length} prompts, one per scene number.`,
  ].join("");
}

// ─── OpenAI Responses API call ────────────────────────────────────────────────

async function callOpenAI(
  scenes: SceneInput[],
  styleGuide: string | null
): Promise<{ result: PromptResult; inputTokens: number; outputTokens: number }> {
  const response = await openai.responses.create({
    model: SCRIPT_MODEL,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: buildUserPrompt(scenes, styleGuide) },
    ],
    text: {
      format: {
        type:   "json_schema",
        name:   "image_prompts",
        strict: true,
        schema: PROMPT_JSON_SCHEMA,
      },
    },
  });

  const parsed = JSON.parse(response.output_text) as PromptResult;

  return {
    result:       parsed,
    inputTokens:  response.usage?.input_tokens  ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

// ─── Inngest function ─────────────────────────────────────────────────────────

export const runStage2Prompts = inngest.createFunction(
  {
    id: "stage-2-prompts",
    triggers: [{ event: "job/stage-2-needed" }],
    retries: 2,
  },
  async ({ event, step }) => {
    const { jobId } = event.data as { jobId: string };

    // ── Step 1: fetch job row ────────────────────────────────────────────────
    const job = await step.run("fetch-job", async () => {
      const sb = getSupabaseAdminClient();
      const { data, error } = await sb
        .from("jobs")
        .select("style_guide, auto_mode")
        .eq("id", jobId)
        .single();
      if (error || !data) throw new Error(`Job not found: ${error?.message}`);
      return data as { style_guide: string | null; auto_mode: boolean };
    });

    // ── Step 2: fetch all scenes ─────────────────────────────────────────────
    const scenes = await step.run("fetch-scenes", async () => {
      const sb = getSupabaseAdminClient();
      const { data, error } = await sb
        .from("scenes")
        .select("scene_number, voiceover_text, on_screen_action, visual_keywords")
        .eq("job_id", jobId)
        .order("scene_number", { ascending: true });
      if (error || !data) throw new Error(`Scenes not found: ${error?.message}`);
      return data as SceneInput[];
    });

    // ── Step 3: call OpenAI ──────────────────────────────────────────────────
    const openaiResult = await step.run("call-openai", async () => {
      const startMs = Date.now();
      const { result, inputTokens, outputTokens } = await callOpenAI(
        scenes,
        job.style_guide
      );

      if (result.prompts.length !== scenes.length) {
        throw new Error(
          `Expected ${scenes.length} prompts, got ${result.prompts.length}`
        );
      }

      const durationMs = Date.now() - startMs;
      const costUsd = computeTextCost(inputTokens, outputTokens);

      await logApiCall({
        jobId,
        provider:        "openai",
        model:           SCRIPT_MODEL,
        operation:       "prompts",
        costUsd,
        durationMs,
        requestPayload:  { scene_count: scenes.length },
        responsePayload: { style_anchor_length: result.style_anchor.length },
        status:          "success",
      });

      return { result, inputTokens, outputTokens, costUsd };
    });

    // ── Step 4: update each scene with combined image prompt ─────────────────
    await step.run("update-scenes", async () => {
      const sb = getSupabaseAdminClient();
      const { style_anchor, prompts } = openaiResult.result;

      const updates = prompts.map((p) =>
        sb
          .from("scenes")
          .update({ image_prompt: `${style_anchor}\n\n${p.image_prompt}` })
          .eq("job_id", jobId)
          .eq("scene_number", p.scene_number)
      );

      const results = await Promise.all(updates);
      for (const { error } of results) {
        if (error) throw new Error(`Failed to update scene: ${error.message}`);
      }
    });

    // ── Step 5: update job status ────────────────────────────────────────────
    const nextStatus = await step.run("update-job-status", async () => {
      const sb = getSupabaseAdminClient();
      const status = job.auto_mode ? "imaging" : "awaiting_prompt_approval";

      const { error } = await sb
        .from("jobs")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", jobId);
      if (error) throw new Error(`Failed to update job status: ${error.message}`);

      return status;
    });

    // ── Step 6: trigger Stage 3 (auto mode only) ─────────────────────────────
    if (nextStatus === "imaging") {
      await step.sendEvent("trigger-stage-3", {
        name: "job/stage-3-needed",
        data: { jobId },
      });
    }

    return {
      jobId,
      sceneCount:   scenes.length,
      inputTokens:  openaiResult.inputTokens,
      outputTokens: openaiResult.outputTokens,
      costUsd:      openaiResult.costUsd,
      nextStatus,
    };
  }
);
