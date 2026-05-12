import { join }                     from "path";
import { tmpdir }                    from "os";
import { writeFile, readFile, unlink, mkdir, rm } from "fs/promises";
import { execFile }                  from "child_process";
import { promisify }                 from "util";
// @ts-ignore — ffmpeg-static ships its own types in some versions
import ffmpegStatic                  from "ffmpeg-static";

import { inngest }                from "@/inngest/client";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

const execFileAsync  = promisify(execFile);
const BUCKET         = "assets";
const SIGNED_URL_TTL = 60 * 60 * 24 * 365; // 1 year

// Prefer the bundled static binary; fall back to whatever is in PATH.
const FFMPEG_BIN: string = (ffmpegStatic as string | null) ?? "ffmpeg";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG_BIN, args, { maxBuffer: 100 * 1024 * 1024 });
}

async function downloadClip(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download clip (${resp.status}): ${url}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  await writeFile(destPath, buffer);
}

// ─── Inngest function ─────────────────────────────────────────────────────────

export const runStage5Stitch = inngest.createFunction(
  {
    id:       "stage-5-stitch",
    triggers: [{ event: "job/stage-5-needed" }],
    retries:  2,
  },
  async ({ event, step }) => {
    const { jobId } = event.data as { jobId: string };

    // ── Step 1: fetch all clip URLs ordered by scene_number ──────────────────
    const clips = await step.run("fetch-clips", async () => {
      const sb = getSupabaseAdminClient();
      const { data, error } = await sb
        .from("scenes")
        .select("scene_number, clip_url")
        .eq("job_id", jobId)
        .order("scene_number", { ascending: true });
      if (error || !data) throw new Error(`Scenes not found: ${error?.message}`);

      const missing = data.filter((s) => !s.clip_url);
      if (missing.length > 0) {
        throw new Error(`${missing.length} scene(s) have no clip_url — did Stage 4 complete?`);
      }
      return data as { scene_number: number; clip_url: string }[];
    });

    // ── Step 2: download clips, stitch, upload master ────────────────────────
    const masterUrl = await step.run("stitch", async () => {
      const tmpDir    = join(tmpdir(), `stitch-${jobId}-${Date.now()}`);
      const listPath  = join(tmpDir, "list.txt");
      const outputPath = join(tmpDir, "master.mp4");

      await mkdir(tmpDir, { recursive: true });

      try {
        // Download all clips in parallel.
        await Promise.all(
          clips.map((c) =>
            downloadClip(c.clip_url, join(tmpDir, `${c.scene_number}.mp4`))
          )
        );

        // Build concat list — one absolute path per line.
        const listContent = clips
          .map((c) => `file '${join(tmpDir, `${c.scene_number}.mp4`)}'`)
          .join("\n");
        await writeFile(listPath, listContent);

        // Try lossless copy first (fast, no re-encode).
        try {
          await runFfmpeg([
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", listPath,
            "-c", "copy",
            outputPath,
          ]);
        } catch {
          // Fall back to re-encode if codec mismatch or corruption.
          await runFfmpeg([
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", listPath,
            "-c:v", "libx264",
            "-c:a", "aac",
            "-preset", "fast",
            outputPath,
          ]);
        }

        // Upload master to Supabase Storage.
        const buffer      = await readFile(outputPath);
        const storagePath = `jobs/${jobId}/master.mp4`;
        const sb          = getSupabaseAdminClient();

        const { error: uploadError } = await sb.storage
          .from(BUCKET)
          .upload(storagePath, buffer, { contentType: "video/mp4", upsert: true });
        if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

        const { data: signed, error: signError } = await sb.storage
          .from(BUCKET)
          .createSignedUrl(storagePath, SIGNED_URL_TTL);
        if (signError || !signed?.signedUrl) {
          throw new Error(`Signed URL failed: ${signError?.message}`);
        }

        return signed.signedUrl;
      } finally {
        // Clean up temp dir regardless of success or failure.
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    // ── Step 3: mark job complete ────────────────────────────────────────────
    await step.run("complete-job", async () => {
      const sb = getSupabaseAdminClient();
      const { error } = await sb
        .from("jobs")
        .update({
          status:            "complete",
          master_video_url:  masterUrl,
          completed_at:      new Date().toISOString(),
          updated_at:        new Date().toISOString(),
        })
        .eq("id", jobId);
      if (error) throw new Error(`Failed to complete job: ${error.message}`);
    });

    return { jobId, masterUrl };
  }
);
