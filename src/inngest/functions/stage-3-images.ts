import { inngest } from "@/inngest/client";
import { openai } from "@/lib/openai";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { MODEL_COSTS, logApiCall } from "@/lib/cost";

const IMAGE_MODEL  = "gpt-image-2";
const BUCKET       = "assets";
const CONCURRENCY  = 4;
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

// ─── Helpers ──────────────────────────────────────────────────────────────────

function imageSize(aspectRatio: string): string {
  return aspectRatio === "9:16" ? "864x1536" : "1536x864";
}

// Processes one scene: generate image → upload → return signed URL.
async function processScene(params: {
  jobId:       string;
  sceneId:     string;
  sceneNumber: number;
  imagePrompt: string;
  aspectRatio: string;
}): Promise<{ imageUrl: string; costUsd: number; durationMs: number }> {
  const startMs = Date.now();

  const response = await openai.images.generate({
    model:   IMAGE_MODEL,
    prompt:  params.imagePrompt,
    size:    imageSize(params.aspectRatio) as Parameters<typeof openai.images.generate>[0]["size"],
    quality: "high",
    n:       1,
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error(`No image data for scene ${params.sceneNumber}`);

  const buffer      = Buffer.from(b64, "base64");
  const storagePath = `jobs/${params.jobId}/images/${params.sceneNumber}.png`;
  const sb          = getSupabaseAdminClient();

  const { error: uploadError } = await sb.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: "image/png", upsert: true });

  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  const { data: signed, error: signError } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    throw new Error(`Signed URL failed: ${signError?.message}`);
  }

  const durationMs = Date.now() - startMs;
  const costUsd    = MODEL_COSTS["gpt-image-2"].per_image;

  await logApiCall({
    jobId:           params.jobId,
    sceneId:         params.sceneId,
    provider:        "openai",
    model:           IMAGE_MODEL,
    operation:       "image",
    costUsd,
    durationMs,
    requestPayload:  { scene_number: params.sceneNumber, prompt_length: params.imagePrompt.length },
    responsePayload: { storage_path: storagePath },
    status:          "success",
  });

  return { imageUrl: signed.signedUrl, costUsd, durationMs };
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SceneRow = {
  id:           string;
  scene_number: number;
  image_prompt: string;
};

// ─── Inngest function ─────────────────────────────────────────────────────────

export const runStage3Images = inngest.createFunction(
  {
    id:       "stage-3-images",
    triggers: [{ event: "job/stage-3-needed" }],
    retries:  2,
  },
  async ({ event, step }) => {
    const { jobId } = event.data as { jobId: string };

    // ── Step 1: fetch job ────────────────────────────────────────────────────
    const job = await step.run("fetch-job", async () => {
      const sb = getSupabaseAdminClient();
      const { data, error } = await sb
        .from("jobs")
        .select("aspect_ratio, auto_mode")
        .eq("id", jobId)
        .single();
      if (error || !data) throw new Error(`Job not found: ${error?.message}`);
      return data as { aspect_ratio: string; auto_mode: boolean };
    });

    // ── Step 2: fetch scenes with image prompts ──────────────────────────────
    const scenes = await step.run("fetch-scenes", async () => {
      const sb = getSupabaseAdminClient();
      const { data, error } = await sb
        .from("scenes")
        .select("id, scene_number, image_prompt")
        .eq("job_id", jobId)
        .order("scene_number", { ascending: true });
      if (error || !data) throw new Error(`Scenes not found: ${error?.message}`);

      const missing = data.filter((s) => !s.image_prompt);
      if (missing.length > 0) {
        throw new Error(
          `${missing.length} scene(s) have no image_prompt — did Stage 2 complete?`
        );
      }
      return data as SceneRow[];
    });

    // ── Step 3: mark all scenes as "imaging" ─────────────────────────────────
    await step.run("mark-scenes-imaging", async () => {
      const sb = getSupabaseAdminClient();
      const { error } = await sb
        .from("scenes")
        .update({ status: "imaging" })
        .eq("job_id", jobId);
      if (error) throw new Error(`Failed to mark scenes imaging: ${error.message}`);
    });

    // ── Step 4: fan-out in batches of CONCURRENCY ────────────────────────────
    // Inngest caches each step result — on retry, completed steps are skipped.
    let totalCostUsd = 0;

    for (let i = 0; i < scenes.length; i += CONCURRENCY) {
      const batch = scenes.slice(i, i + CONCURRENCY);

      const results = await Promise.all(
        batch.map((scene) =>
          step.run(`generate-image-${scene.scene_number}`, async () => {
            const { imageUrl, costUsd, durationMs } = await processScene({
              jobId,
              sceneId:     scene.id,
              sceneNumber: scene.scene_number,
              imagePrompt: scene.image_prompt,
              aspectRatio: job.aspect_ratio,
            });

            // Update scene immediately so partial results are visible.
            const sb = getSupabaseAdminClient();
            const { error } = await sb
              .from("scenes")
              .update({ image_url: imageUrl, status: "done" })
              .eq("id", scene.id);
            if (error) throw new Error(`Failed to update scene ${scene.scene_number}: ${error.message}`);

            return { costUsd, durationMs };
          })
        )
      );

      for (const r of results) totalCostUsd += r.costUsd;
    }

    // ── Step 5: update job status ────────────────────────────────────────────
    const nextStatus = await step.run("update-job-status", async () => {
      const sb     = getSupabaseAdminClient();
      const status = job.auto_mode ? "videoing" : "awaiting_image_approval";

      const { error } = await sb
        .from("jobs")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", jobId);
      if (error) throw new Error(`Failed to update job status: ${error.message}`);

      return status;
    });

    // ── Step 6: trigger Stage 4 (auto mode only) ─────────────────────────────
    if (nextStatus === "videoing") {
      await step.sendEvent("trigger-stage-4", {
        name: "job/stage-4-needed",
        data: { jobId },
      });
    }

    return {
      jobId,
      sceneCount:  scenes.length,
      totalCostUsd,
      nextStatus,
    };
  }
);
