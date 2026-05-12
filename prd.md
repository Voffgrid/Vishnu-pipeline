# Product Requirements Document
## Script-to-Video Pipeline

**Internal codename:** TBD
**Owner:** Bunny (Overmind Labs)
**Version:** 1.0
**Date:** May 12, 2026
**Status:** Draft for build

---

## 1. Executive Summary

This product is an internal web-based pipeline that turns a written script and a target duration into a fully stitched, audio-included video. The user pastes a raw script, picks a duration (e.g. 3 minutes), and the system orchestrates a four-stage AI pipeline:

1. GPT structures the script into 8-second scene beats with timing
2. GPT writes one image prompt per scene
3. GPT Image 2 generates a reference still per scene
4. Veo 3 generates a video per scene using the still as the visual anchor (Veo 3 also generates the audio natively)

All clips are then stitched into a single master MP4 using FFmpeg.

The user has two operating modes: an **Approval Mode** with checkpoints between stages (script → prompts → images → videos), and an **Auto-Generate Mode** that runs end-to-end with no intervention. Auto mode is toggled at job creation.

**Hosting:** Vercel Pro (Next.js 15). **Storage:** Supabase (Postgres + Storage buckets). Stitching and FFmpeg work runs on a worker outside Vercel because Vercel functions cap at 800s for Pro and FFmpeg jobs on long videos exceed that — covered in Section 9 (Architecture).

---

## 2. Goals and Non-Goals

### 2.1 Goals (v1)

- Accept a script of any length and a target duration up to 5 minutes.
- Automatically segment the script into 8-second scene beats with precise per-scene durations.
- Generate one anchor image per scene with GPT Image 2 for consistent visual reference.
- Generate one Veo 3 video clip per scene (image-to-video, native audio).
- Stitch all clips into a single master MP4 named `master.mp4`, alongside numbered scene files (`1.mp4`, `2.mp4`, ...).
- Provide an Approval Mode (per-stage human gate) and an Auto-Generate Mode (no gates).
- Resumability: a failed scene must be retryable without redoing the whole job.
- Show real-time progress per scene per stage.
- Track and surface per-job cost in USD.

### 2.2 Non-Goals (v1)

- Multi-user / multi-tenant. This is single-user (Bunny) initially. Auth = a simple shared secret or magic link.
- Manual scene editing in the UI. The user can re-run a scene with a tweaked prompt, but no timeline editor.
- Custom voiceover / TTS pipeline. Veo 3 native audio only.
- Character consistency guarantees across scenes (see Section 13: Known Risks).
- Subtitles, captions, transitions, motion graphics, background music overlay.
- Mobile app. Desktop web only.

---

## 3. Target User and Use Cases

**Primary user:** Bunny — running content production for @syntax_sarcasm and adjacent projects. Use cases include short-form educational videos, faceless YouTube content, and ad creative iteration.

### 3.1 Primary use case flow

1. Bunny pastes a 3-minute monologue script into the dashboard.
2. Selects duration = 3:00, toggles Auto-Generate ON.
3. Clicks Generate.
4. Returns ~25–40 minutes later (depending on Veo 3 queue latency) to a finished `master.mp4` plus per-scene MP4s.
5. Downloads the bundle as a zip or pulls individual clips.

---

## 4. Functional Requirements

### 4.1 Dashboard

- Job list table: columns = Title, Created, Duration, Status, Cost, Actions.
- Statuses: `draft`, `scripting`, `awaiting_script_approval`, `prompting`, `awaiting_prompt_approval`, `imaging`, `awaiting_image_approval`, `videoing`, `stitching`, `complete`, `failed`, `cancelled`.
- "New Job" button opens the creation form.
- Click row → job detail page.

### 4.2 New Job Form

- **Field:** Title (string, required).
- **Field:** Script (multiline textarea, required, min 50 chars, max 10000 chars).
- **Field:** Target Duration (slider or input, 8s to 300s, in 8s steps so it always evenly maps to scenes).
- **Field:** Aspect Ratio (radio: 16:9 / 9:16). Default 16:9.
- **Field:** Resolution (radio: 720p / 1080p). Default 720p (cheaper).
- **Field:** Style Guide (optional textarea — e.g. "cinematic, warm lighting, shallow depth of field"). Passed to image-prompt step.
- **Toggle:** Auto-Generate (default OFF). When ON, no approval gates — pipeline runs end-to-end.
- **Toggle:** Use Veo 3 Fast (default ON — saves 62% on cost). When OFF, uses standard Veo 3.
- **Estimated cost** displayed live as user adjusts duration/resolution/model (computed client-side from the cost table in Section 11).
- **Button:** Generate → POSTs to `/api/jobs`, redirects to job detail page.

### 4.3 Job Detail Page

This is the main work surface. Layout:

- **Header:** title, status pill, cost-so-far, total elapsed time, Cancel button.
- **Stage 1 panel — Script Breakdown:** shows the JSON returned by GPT (scene array with start_time, end_time, voiceover_text, on_screen_action). Editable if in approval mode. Approve / Reject / Edit buttons.
- **Stage 2 panel — Image Prompts:** one card per scene showing the generated image prompt. Editable in approval mode.
- **Stage 3 panel — Reference Images:** grid of generated stills, one per scene. Each card has: image preview, "Regenerate this scene" button (uses original or edited prompt), "Edit prompt and regenerate" inline.
- **Stage 4 panel — Video Clips:** same grid layout, each card has the playable MP4, retry button, and a "View Veo 3 prompt sent" debug link.
- **Stage 5 panel — Master Video:** final stitched MP4 player + download button + download-all-clips zip button.
- In approval mode, each panel has an Approve and Continue button. In auto mode, panels just stream updates.

### 4.4 Auto-Generate Mode

When enabled at job creation, the server processes all stages with no human gate. Approval buttons are hidden. The job goes straight from `scripting` → `prompting` → `imaging` → `videoing` → `stitching` → `complete` unless a stage errors. On error, the job pauses in a `failed_recoverable` state and surfaces a Retry button for the failing scene.

### 4.5 Approval Mode

When auto is OFF, after each stage the job enters an `awaiting_*_approval` state. The user can:

- **Approve:** triggers the next stage.
- **Edit and approve:** persist edits, then trigger next stage.
- **Reject and re-run:** re-runs the current stage from scratch (new GPT call, etc.).
- **Cancel:** terminates the job, refunds nothing (already-spent costs are sunk).

### 4.6 Scene Retry

From the job detail page, at any post-creation stage, the user can retry a single scene without re-running the whole pipeline. Retry semantics:

- Retrying an image regenerates only that scene's image and then re-runs Veo 3 for that scene only. The master gets re-stitched at the end.
- Retrying a video clip re-runs Veo 3 for that scene with the same image. Master re-stitched.
- Editing a prompt regenerates downstream artifacts for that scene only.

### 4.7 Master Stitch

After all scene videos are complete, the worker runs FFmpeg concat to produce `master.mp4`. Stitching is lossless (concat demuxer, codec copy) because Veo 3 outputs uniform H.264/AAC clips. If clip codecs ever diverge, fall back to re-encode.

### 4.8 File Naming and Storage Layout

Per job, the Supabase Storage bucket layout is:

```
jobs/{job_id}/
  script.json
  prompts.json
  images/1.png, 2.png, ...
  clips/1.mp4, 2.mp4, ...
  master.mp4
  bundle.zip   (created on first download request)
```

---

## 5. Key User Flows

### 5.1 Happy path (Auto mode)

1. User opens dashboard → clicks New Job.
2. Fills form: title="AI ethics explainer", duration=2:24 (18 scenes × 8s), aspect=16:9, resolution=720p, auto=ON, Veo 3 Fast=ON.
3. Sees estimated cost: ~$22 (18 × 8s × $0.15 Veo Fast + image gen).
4. Clicks Generate. Redirected to job page.
5. Status pill cycles through `scripting` → `prompting` → `imaging` → `videoing` → `stitching` → `complete`.
6. Total wall time ~25–40 min.
7. User downloads `master.mp4`.

### 5.2 Approval mode flow

1. Same form, auto=OFF.
2. Job enters `scripting`, then pauses at `awaiting_script_approval`.
3. User reviews the 18-scene breakdown, edits scene 7's voiceover line, clicks Approve.
4. Job enters `prompting`, then pauses at `awaiting_prompt_approval`.
5. User reviews 18 image prompts, rewrites prompt for scene 3, clicks Approve.
6. Job enters `imaging`, then pauses at `awaiting_image_approval`.
7. User reviews 18 images, regenerates scene 11 (didn't like the composition), then Approves.
8. Job enters `videoing`, runs to completion, stitches, done.

### 5.3 Failure recovery

1. Scene 12's Veo 3 call fails (content policy hit or timeout).
2. Job moves to `failed_recoverable`. Status pill turns yellow.
3. User clicks Retry on scene 12's card. Re-runs only that scene.
4. On success, master gets re-stitched and job goes to `complete`.

---

## 6. Pipeline Stages — Detailed Spec

### 6.1 Stage 1 — Script Structuring (OpenAI GPT)

**Model:** gpt-5.4 (or current best general model). **Endpoint:** `/v1/responses` with structured outputs.

**Goal:** take raw script text + target duration, output a JSON array of scenes, each exactly 8 seconds, where the sum equals the requested duration.

**Prompt skeleton:**

```
SYSTEM: You are a video director's assistant. Convert a script into N scenes,
each exactly 8 seconds long. The total scenes × 8 must equal the target duration.
Each scene must contain: scene_number, start_time, end_time, voiceover_text
(what the narrator says during this scene), on_screen_action (what the camera
sees), and visual_keywords (3–6 tokens for style continuity).

USER: Script: """<raw script>"""
Target duration: <duration_seconds>
Number of scenes: <duration_seconds / 8>
Style guide: <style_guide or none>
```

**Output schema (enforced via structured outputs):**

```json
{
  "scenes": [
    {
      "scene_number": 1,
      "start_time": 0,
      "end_time": 8,
      "voiceover_text": "string",
      "on_screen_action": "string",
      "visual_keywords": ["string"]
    }
  ]
}
```

**Validation on receipt:** `scenes.length === duration_seconds / 8`. Otherwise auto-retry once with a stricter prompt, then surface error.

### 6.2 Stage 2 — Image Prompt Writing (OpenAI GPT)

**Model:** same — gpt-5.4. One call, batched: pass the entire scene array and ask for one image prompt per scene plus a global "style anchor" paragraph that gets prepended to every scene prompt for visual consistency.

**Output schema:**

```json
{
  "style_anchor": "A consistent visual style paragraph used across all scenes.",
  "prompts": [
    { "scene_number": 1, "image_prompt": "..." },
    { "scene_number": 2, "image_prompt": "..." }
  ]
}
```

The final prompt sent to GPT Image 2 per scene is: `style_anchor + "\n\n" + image_prompt`.

### 6.3 Stage 3 — Image Generation (GPT Image 2)

**Model:** `gpt-image-2` (snapshot `gpt-image-2-2026-04-21`). **Endpoint:** `/v1/images/generations`.

Per scene: one image, size matching aspect ratio (1024×576 for 16:9, 576×1024 for 9:16). Quality: high. Save the PNG to Supabase Storage at `jobs/{id}/images/{scene_number}.png`.

**Rate limit awareness:** GPT Image 2 tier-1 = 5 IPM, tier-3 = 50 IPM, tier-5 = 250 IPM. For a 3-minute job (22 scenes), tier-1 means ~5 min just to generate images sequentially. Recommend tier-3 minimum. Concurrency capped at the tier's IPM ÷ 60 × safety_factor (0.8).

### 6.4 Stage 4 — Video Generation (Veo 3)

**Provider:** Google Gemini API (Vertex AI as fallback). **Models:** `veo-3-fast` (default, $0.15/sec, $1.20 per 8s clip with audio) or `veo-3` (premium, $0.40/sec, $3.20 per 8s clip).

**Per scene API call:**

```
POST /v1/models/veo-3-fast:generateContent
{
  "prompt": "<scene.on_screen_action> + <scene.voiceover_text as spoken dialogue>",
  "image": { "bytesBase64Encoded": "<base64 of scene image>", "mimeType": "image/png" },
  "config": {
    "aspectRatio": "16:9",
    "resolution": "720p",
    "durationSeconds": 8,
    "generateAudio": true,
    "personGeneration": "allow_adult"
  }
}
```

Veo 3 is async — the call returns an operation ID, and the worker polls every 10s until the operation completes (typical 60–180s per clip). On completion, download the MP4 and save to `jobs/{id}/clips/{scene_number}.mp4`.

**Concurrency:** Gemini API has per-project quotas. Start at 4 concurrent Veo 3 calls; tune up after observing rate limit headers. With concurrency=4 and ~120s per clip, a 22-scene job takes ~11 minutes for the Veo stage alone.

### 6.5 Stage 5 — Stitching (FFmpeg)

Worker downloads all `clips/*.mp4` in scene order to a temp directory and runs:

```bash
# Build a concat list file
1.mp4
2.mp4
...
N.mp4

ffmpeg -f concat -safe 0 -i list.txt -c copy master.mp4
```

Lossless concat works because Veo 3 outputs uniform encoding params. If the concat ever produces invalid output (codec mismatch), fall back to:

```bash
ffmpeg -f concat -safe 0 -i list.txt -c:v libx264 -c:a aac -preset fast master.mp4
```

Upload `master.mp4` to Supabase Storage at `jobs/{id}/master.mp4`. Generate a signed URL for the user.

---

## 7. Data Model (Postgres / Supabase)

### 7.1 `jobs` table

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | gen_random_uuid() |
| user_id | uuid | FK to auth.users (single user for v1) |
| title | text | user-provided |
| script | text | raw input |
| duration_seconds | int | must be multiple of 8 |
| aspect_ratio | text | '16:9' or '9:16' |
| resolution | text | '720p' or '1080p' |
| style_guide | text | nullable |
| auto_mode | boolean | default false |
| veo_model | text | 'veo-3-fast' or 'veo-3' |
| status | text | see status enum in 4.1 |
| cost_usd | numeric(10,4) | running total |
| error_message | text | nullable |
| master_video_url | text | signed URL once complete |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |
| completed_at | timestamptz | nullable |

### 7.2 `scenes` table

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| job_id | uuid FK | → jobs(id) ON DELETE CASCADE |
| scene_number | int | 1-indexed |
| start_time | int | in seconds |
| end_time | int | in seconds |
| voiceover_text | text | |
| on_screen_action | text | |
| visual_keywords | text[] | |
| image_prompt | text | nullable until stage 2 |
| image_url | text | nullable until stage 3 |
| clip_url | text | nullable until stage 4 |
| veo_operation_id | text | Gemini operation handle |
| status | text | pending/imaging/videoing/done/failed |
| error_message | text | nullable |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Unique constraint: `(job_id, scene_number)`.

### 7.3 `api_calls` table (audit / cost tracking)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| job_id | uuid FK | |
| scene_id | uuid FK | nullable (script/prompt calls have no scene) |
| provider | text | 'openai' or 'google' |
| model | text | 'gpt-5.4', 'gpt-image-2', 'veo-3-fast', etc. |
| operation | text | 'script', 'prompts', 'image', 'video' |
| cost_usd | numeric(10,4) | |
| duration_ms | int | wall-clock latency |
| request_payload | jsonb | for debugging |
| response_payload | jsonb | trimmed |
| status | text | success/error |
| error_code | text | nullable |
| created_at | timestamptz | |

---

## 8. Internal API Surface

Next.js 15 App Router. All routes under `/api/`. Auth via a single shared-secret header `X-Auth-Token` in v1 (rotate via env var).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/jobs` | Create a new job. Validates input, persists row, enqueues stage-1 task. |
| GET | `/api/jobs` | List jobs for current user. |
| GET | `/api/jobs/:id` | Job detail incl. scenes array. |
| DELETE | `/api/jobs/:id` | Cancel + soft-delete. |
| POST | `/api/jobs/:id/approve` | Body: `{ stage }`. Triggers next stage in approval mode. |
| POST | `/api/jobs/:id/reject` | Body: `{ stage }`. Re-runs current stage. |
| PATCH | `/api/jobs/:id/scenes/:n` | Edit voiceover, on_screen_action, or image_prompt for a scene. |
| POST | `/api/jobs/:id/scenes/:n/retry` | Body: `{ from_stage: 'image'\|'video' }`. Retries that scene. |
| GET | `/api/jobs/:id/events` | SSE stream of status updates for the detail page. |
| GET | `/api/jobs/:id/download` | Returns signed URL to `master.mp4` (or builds `bundle.zip` if requested). |

---

## 9. Architecture

### 9.1 Why the worker can't run on Vercel

Vercel Pro function timeout is 800s. A 3-minute (22-scene) job's Veo stage takes 11+ minutes of polling alone — and we want a single coordinator process per job. So:

- Vercel hosts the Next.js frontend and the lightweight API routes (job CRUD, SSE).
- A long-running worker handles the actual pipeline. Options, in preference order:
  - **Option A (recommended):** a dedicated Node.js worker on Railway / Fly.io / Render. Cheap ($5–20/mo), no timeout, simple deploy. Connects to the same Supabase Postgres.
  - **Option B:** Inngest or Trigger.dev — durable function platforms that handle retries, sleeps, and long-running steps natively. Higher abstraction, faster to build, but adds a vendor.
  - **Option C:** Supabase Edge Functions + a self-hosted ffmpeg container. Doable but stitches across more pieces.

**Recommendation:** Option B (Inngest) for v1 because it eliminates queue/retry boilerplate and has free tier covering this volume. Move to Option A if Inngest costs spike.

### 9.2 Component diagram (logical)

```
Browser
   │
   ▼
Next.js on Vercel  ─────►  Supabase Postgres + Storage
   │   (API routes)
   │
   ▼
Inngest (or worker)
   │
   ├──► OpenAI API (GPT, GPT Image 2)
   ├──► Google Gemini API (Veo 3)
   └──► FFmpeg (local in worker) ──► Supabase Storage (master.mp4)
```

### 9.3 Job state machine

```
draft
  └─► scripting ──► awaiting_script_approval ──┐
                                                ▼
                                              prompting ──► awaiting_prompt_approval ──┐
                                                                                        ▼
                                                                                      imaging ──► awaiting_image_approval ──┐
                                                                                                                              ▼
                                                                                                                            videoing ──► stitching ──► complete
                                                                                                                                  │
                                                                                                                                  └─► failed_recoverable ──► (retry) ──► videoing
```

In auto mode, the `awaiting_*_approval` states are skipped — the worker transitions directly to the next active state.

---

## 10. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | Next.js 15 (App Router), TypeScript, React 19 | Vercel Pro, your existing stack. |
| Styling | Tailwind v4 + shadcn/ui | Fast, consistent. |
| State / data fetch | TanStack Query + SSE for live updates | Real-time progress without WebSocket complexity. |
| Auth | Supabase Auth (magic link, single user allowlist) | Same Supabase project. |
| DB | Supabase Postgres | Free tier fine for v1. |
| Storage | Supabase Storage | Images and videos. |
| Worker | Inngest | Durable functions, free tier. |
| LLM | OpenAI: gpt-5.4 + gpt-image-2 | Per requirement. |
| Video | Google Gemini API: veo-3-fast (default) / veo-3 | Per requirement, audio included. |
| Video processing | FFmpeg (in worker container) | Concat-demuxer stitching. |
| Logging | Axiom or Vercel logs | Cheap, structured. |
| Error tracking | Sentry | API failures and worker crashes. |

---

## 11. Cost Model

Per-job cost = OpenAI text + OpenAI image + Veo 3 video. Veo dominates by far.

### 11.1 Unit costs (as of May 2026)

| Service | Unit | Cost |
|---|---|---|
| OpenAI gpt-5.4 (script + prompts) | per job | ~$0.05 (small input/output) |
| GPT Image 2 (high quality) | per image | ~$0.17 |
| Veo 3 Fast | per second (with audio) | $0.15 |
| Veo 3 Standard | per second (with audio) | $0.40 |
| Supabase Storage | per GB-month | $0.021 |
| Inngest | per run | free up to 50k/month |

### 11.2 Cost per finished video

| Duration | Scenes | Veo Fast cost | Veo Std cost | + Images | Total Fast |
|---|---|---|---|---|---|
| 24s | 3 | $3.60 | $9.60 | $0.51 | **~$4.16** |
| 1:00 | 8 (rounded to 64s) | $9.60 | $25.60 | $1.36 | **~$11.01** |
| 3:00 | 23 (rounded to 184s) | $27.60 | $73.60 | $3.91 | **~$31.56** |
| 5:00 | 38 (rounded to 304s) | $45.60 | $121.60 | $6.46 | **~$52.11** |

Note: duration is always rounded up to a multiple of 8 internally so the UI must enforce the constraint or round transparently.

### 11.3 Cost guardrails

- Hard cap per job: $100 default, configurable in settings. Pre-flight refuses jobs estimated above the cap unless user explicitly overrides.
- Monthly spend cap: $500 default. Worker refuses to start new jobs once this is hit until manual reset.
- Cost displayed live in the form and in the job header throughout execution.

---

## 12. Performance Targets

| Stage | Target (3-min job) | Notes |
|---|---|---|
| Script breakdown | < 30s | One GPT call |
| Prompt writing | < 30s | One GPT call |
| Image generation (22 scenes, concurrency 4) | 3–6 min | Tier-3 IPM headroom |
| Video generation (22 scenes, concurrency 4) | 11–18 min | Veo 3 Fast async polling |
| Stitching | < 60s | Concat copy is near-instant |
| **Total wall time** | **20–30 min** | Auto mode, 3-min target |

---

## 13. Known Risks and Mitigations

### 13.1 Character / style continuity across scenes

Veo 3 image-to-video uses each scene's still as the anchor, but if scene N's image shows a character whose face drifts from scene N-1's image, the video will feel disjointed. GPT Image 2 doesn't guarantee character consistency across separate generations.

**Mitigations for v1:**
- The `style_anchor` paragraph in stage 2 pins lighting, color palette, lens, and broad subject description across all prompts.
- In approval mode, the user can manually regenerate any visually-inconsistent scene before videoing.
- v2 idea: use GPT Image 2's image-input mode to feed scene 1's image as a reference when generating scenes 2–N. The model supports image inputs — worth piloting.

### 13.2 Veo 3 content policy rejections

Veo 3 will refuse certain prompts (violence, real people, copyrighted material, minors). Each refused scene blocks the whole video.

**Mitigations:** catch the Veo error, surface a clear message on that scene's card with the policy reason. Auto mode pauses the whole job in `failed_recoverable` so the user can edit the prompt and retry.

### 13.3 Cost runaway

A 5-minute Veo 3 Standard job is $122. An accidental click could burn money fast. See 11.3 guardrails. Also: confirmation modal on Generate showing the dollar estimate in bold red if > $50.

### 13.4 Veo 3 latency variability

Reported Veo 3 latency ranges from 30s to 5min per clip during peak hours. With 22 scenes at concurrency 4, the long tail dominates. **Mitigation:** increase concurrency to 8 if quota allows; show a progress bar based on scenes-done not time-elapsed; let user step away.

### 13.5 FFmpeg concat failure on codec drift

Veo 3 should output uniform clips but if Google updates the encoder mid-job, copy-concat fails. **Mitigation:** detect ffprobe mismatch before concat and fall back to re-encode. Adds ~30s for a 3-min video.

---

## 14. Phased Build Plan

### Phase 0 — Scaffolding (Day 1)

- Next.js 15 app on Vercel, Tailwind, shadcn/ui.
- Supabase project with auth, jobs, scenes, api_calls tables.
- Inngest account + simple hello-world function.
- Env vars: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `SUPABASE_*`, `INNGEST_*`, `AUTH_SECRET`.

### Phase 1 — Pipeline backbone, no UI polish (Days 2–4)

- `POST /api/jobs` creates a row and triggers Inngest function.
- Inngest function runs all 4 stages sequentially in auto mode only.
- Implement each stage as a separate Inngest step with retry config.
- FFmpeg in the Inngest function (either via Docker base image or by offloading stitching to a separate Render/Fly service if Inngest sandboxing limits ffmpeg).
- Test end-to-end with a 24-second (3-scene) script. Verify costs match estimates.

### Phase 2 — UI (Days 5–7)

- Dashboard with job list.
- New job form with live cost preview.
- Job detail page with SSE for live status.
- Master video player + download.

### Phase 3 — Approval mode (Days 8–9)

- Pause states between stages.
- Editable script, prompts, images grids.
- Approve / Reject / Edit endpoints.

### Phase 4 — Retry, recovery, polish (Days 10–11)

- Per-scene retry.
- Master re-stitch on any scene change.
- Cost guardrails and confirmation modal.
- `bundle.zip` download.

### Phase 5 — Production hardening (Day 12)

- Sentry error tracking.
- Axiom or Vercel logs structured.
- Monthly spend cap enforcement.
- Documentation and runbook for failure recovery.

---

## 15. Open Questions

- Veo 3 access path: Gemini API (simpler, $0.40/sec) vs Vertex AI (more setup, similar price). Recommendation: Gemini API for v1.
- Should the duration slider allow non-multiples of 8 and round transparently, or force 8-second steps in the UI? (Recommendation: force 8s steps, label as "24s, 32s, 40s, ...")
- Where does FFmpeg live? If Inngest can't run ffmpeg binaries reliably, do we add a small Render worker just for stitching, or use AWS Lambda with a layer?
- Storage retention: how long to keep generated assets? Default proposal: 30 days, then auto-purge unless job is starred.
- Future feature priority: character consistency (image-as-reference), background music overlay, subtitles, or batch jobs?

---

## 16. Success Metrics (v1)

- **Time-to-first-video:** < 30 minutes for a 3-minute script in auto mode.
- **Cost predictability:** actual cost within ±5% of pre-flight estimate.
- **Scene success rate:** ≥ 95% of scenes produce a usable clip on first try.
- **Job success rate:** ≥ 90% of jobs reach `complete` without human intervention beyond retries.
- **User satisfaction** (just Bunny for v1): subjective "would publish without further editing" rate ≥ 70%.

---

## 17. Appendix

### 17.1 Glossary

- **Scene:** an 8-second segment of the final video, the atomic unit of generation.
- **Beat:** same as scene, used interchangeably.
- **Anchor image:** the still produced by GPT Image 2 that Veo 3 animates.
- **Master:** the final stitched MP4.

### 17.2 References

- GPT Image 2 docs: developers.openai.com/api/docs/models/gpt-image-2
- Veo 3 pricing (Gemini API): $0.40/sec Standard, $0.15/sec Fast, both with audio
- OpenAI structured outputs: developers.openai.com/api/docs/guides/structured-outputs
- Vercel Pro function timeout: 800s
- Inngest durable functions: inngest.com
