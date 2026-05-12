import { join }       from "path";
import { tmpdir }      from "os";
import { readFile, unlink } from "fs/promises";

import { inngest }                   from "@/inngest/client";
import { google, VEO_MODEL_MAP }     from "@/lib/google";
import { getSupabaseAdminClient }    from "@/lib/supabase-admin";
import { computeVideoCost, logApiCall } from "@/lib/cost";

const BUCKET             = "assets";
const CONCURRENCY        = 4;
const SIGNED_URL_TTL     = 60 * 60 * 24 * 365; // 1 year
const POLL_INTERVAL_MS   = 10_000;
const MAX_POLL_MS        = 10 * 60 * 1000; // 10 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

type SceneRow = {
  id:               string;
  scene_number:     number;
  image_url:        string;
  voiceover_text:   string;
  on_screen_action: string;
};

// ─── Per-scene generator ──────────────────────────────────────────────────────

async function generateVideo(params: {
  jobId:           string;
  sceneId:         string;
  sceneNumber:     number;
  imageUrl:        string;
  voiceoverText:   string;
  onScreenAction:  string;
  veoModel:        string;
  aspectRatio:     string;
  resolution:      string;
}): Promise<{ clipUrl: string; costUsd: number; durationMs: number; operationName: string }> {
  const startMs = Date.now();
  const modelId = VEO_MODEL_MAP[params.veoModel] ?? params.veoModel;
  const prompt  = `${params.onScreenAction}. ${params.voiceoverText}`;

  // Fetch scene image and convert to base64.
  const imgResp = await fetch(params.imageUrl);
  if (!imgResp.ok) throw new Error(`Failed to fetch image for scene ${params.sceneNumber}: ${imgResp.status}`);
  const imageBytes = Buffer.from(await imgResp.arrayBuffer()).toString("base64");

  // Submit generation request.
  let operation = await google.models.generateVideos({
    model:  modelId,
    prompt,
    image:  { imageBytes, mimeType: "image/png" },
    config: {
      aspectRatio:      params.aspectRatio,
      resolution:       params.resolution,
      durationSeconds:  8,
      personGeneration: "allow_adult",
      numberOfVideos:   1,
    },
  });

  const operationName = operation.name ?? "";

  // Poll until done or timeout.
  const deadline = startMs + MAX_POLL_MS;
  while (!operation.done) {
    if (Date.now() > deadline) {
      throw new Error(`Veo timed out after 10 min for scene ${params.sceneNumber}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    operation = await google.operations.getVideosOperation({ operation });
  }

  if (operation.error) {
    throw new Error(`Veo refused scene ${params.sceneNumber}: ${JSON.stringify(operation.error)}`);
  }

  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) throw new Error(`No video in Veo response for scene ${params.sceneNumber}`);

  // Download to temp file → buffer → Supabase Storage.
  const tmpPath = join(tmpdir(), `${params.jobId}-${params.sceneNumber}-${Date.now()}.mp4`);
  await google.files.download({ file: video, downloadPath: tmpPath });

  const buffer = await readFile(tmpPath);
  await unlink(tmpPath).catch(() => {}); // non-fatal

  const storagePath = `jobs/${params.jobId}/clips/${params.sceneNumber}.mp4`;
  const sb = getSupabaseAdminClient();

  const { error: uploadError } = await sb.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: "video/mp4", upsert: true });
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  const { data: signed, error: signError } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL);
  if (signError || !signed?.signedUrl) throw new Error(`Signed URL failed: ${signError?.message}`);

  const durationMs = Date.now() - startMs;
  const costUsd    = computeVideoCost(params.veoModel as "veo-3-fast" | "veo-3", 8);

  await logApiCall({
    jobId:           params.jobId,
    sceneId:         params.sceneId,
    provider:        "google",
    model:           modelId,
    operation:       "video",
    costUsd,
    durationMs,
    requestPayload:  { scene_number: params.sceneNumber, prompt_length: prompt.length },
    responsePayload: { storage_path: storagePath, operation_name: operationName },
    status:          "success",
  });

  return { clipUrl: signed.signedUrl, costUsd, durationMs, operationName };
}

// ─── Inngest function ─────────────────────────────────────────────────────────

export const runStage4Videos = inngest.createFunction(
  {
    id:       "stage-4-videos",
    triggers: [{ event: "job/stage-4-needed" }],
    retries:  2,
  },
  async ({ event, step }) => {
    const { jobId } = event.data as { jobId: string };

    // ── Step 1: fetch job ────────────────────────────────────────────────────
    const job = await step.run("fetch-job", async () => {
      const sb = getSupabaseAdminClient();
      const { data, error } = await sb
        .from("jobs")
        .select("veo_model, aspect_ratio, resolution, auto_mode")
        .eq("id", jobId)
        .single();
      if (error || !data) throw new Error(`Job not found: ${error?.message}`);
      return data as {
        veo_model:    string;
        aspect_ratio: string;
        resolution:   string;
        auto_mode:    boolean;
      };
    });

    // ── Step 2: fetch scenes ─────────────────────────────────────────────────
    const scenes = await step.run("fetch-scenes", async () => {
      const sb = getSupabaseAdminClient();
      const { data, error } = await sb
        .from("scenes")
        .select("id, scene_number, image_url, voiceover_text, on_screen_action")
        .eq("job_id", jobId)
        .order("scene_number", { ascending: true });
      if (error || !data) throw new Error(`Scenes not found: ${error?.message}`);

      const missing = data.filter((s) => !s.image_url);
      if (missing.length > 0) {
        throw new Error(`${missing.length} scene(s) have no image_url — did Stage 3 complete?`);
      }
      return data as SceneRow[];
    });

    // ── Step 3: mark all scenes as videoing ──────────────────────────────────
    await step.run("mark-scenes-videoing", async () => {
      const sb = getSupabaseAdminClient();
      const { error } = await sb
        .from("scenes")
        .update({ status: "videoing" })
        .eq("job_id", jobId);
      if (error) throw new Error(`Failed to mark scenes videoing: ${error.message}`);
    });

    // ── Step 4: fan-out in batches of CONCURRENCY ────────────────────────────
    // Each step.run() result is cached — on retry only failed scenes re-run.
    let totalCostUsd = 0;

    for (let i = 0; i < scenes.length; i += CONCURRENCY) {
      const batch = scenes.slice(i, i + CONCURRENCY);

      const results = await Promise.all(
        batch.map((scene) =>
          step.run(`generate-video-${scene.scene_number}`, async () => {
            const { clipUrl, costUsd, operationName } = await generateVideo({
              jobId,
              sceneId:        scene.id,
              sceneNumber:    scene.scene_number,
              imageUrl:       scene.image_url,
              voiceoverText:  scene.voiceover_text,
              onScreenAction: scene.on_screen_action,
              veoModel:       job.veo_model,
              aspectRatio:    job.aspect_ratio,
              resolution:     job.resolution,
            });

            // Update scene immediately — partial results visible as they arrive.
            const sb = getSupabaseAdminClient();
            const { error } = await sb
              .from("scenes")
              .update({
                clip_url:         clipUrl,
                veo_operation_id: operationName,
                status:           "done",
              })
              .eq("id", scene.id);
            if (error) throw new Error(`Failed to update scene ${scene.scene_number}: ${error.message}`);

            return { costUsd };
          })
        )
      );

      for (const r of results) totalCostUsd += r.costUsd;
    }

    // ── Step 5: update job status → stitching ────────────────────────────────
    // There is no video-approval checkpoint in the schema; stitching is always next.
    await step.run("update-job-status", async () => {
      const sb = getSupabaseAdminClient();
      const { error } = await sb
        .from("jobs")
        .update({ status: "stitching", updated_at: new Date().toISOString() })
        .eq("id", jobId);
      if (error) throw new Error(`Failed to update job status: ${error.message}`);
    });

    // ── Step 6: trigger Stage 5 ───────────────────────────────────────────────
    await step.sendEvent("trigger-stage-5", {
      name: "job/stage-5-needed",
      data: { jobId },
    });

    return { jobId, sceneCount: scenes.length, totalCostUsd };
  }
);
