# Build Plan — Script-to-Video Pipeline

**Companion to:** `PRD.md`
**For:** Solo build, executing in Cursor / Claude Code yourself
**Total estimated time:** ~12 working days

---

## How to use this plan

- Phases are sequential. Don't skip ahead.
- Each phase has a **goal**, **deliverables**, **steps**, and a **test checklist**.
- Every test in the checklist must pass before moving to the next phase. If you skip Phase 2's end-to-end test, you'll debug Phase 2 bugs in Phase 5.
- Budget ~$30 for testing — every Veo 3 call in Phase 5+ is real money.
- Keep a `DECISIONS.md` log. When you pick Inngest over Trigger.dev (or anything else), write down why.

---

## Phase 0 — Scaffolding

**Goal:** Repo exists, deploys to Vercel, talks to Supabase, secrets work. Nothing else.

**Time:** Half a day.

### Deliverables

- Next.js 15 app (TypeScript, Tailwind v4, shadcn/ui, App Router)
- Supabase project created (dedicated to this app)
- Vercel project linked to GitHub repo, auto-deploying on push to main
- Inngest account + dev server running locally
- `.env.local` filled, `.env.example` committed
- Healthcheck endpoint working in production

### Steps

```bash
npx create-next-app@latest script-to-video --typescript --tailwind --app --src-dir --import-alias "@/*"
cd script-to-video
npm install @supabase/supabase-js @supabase/ssr inngest zod
npx shadcn@latest init -d
npx shadcn@latest add button input textarea card badge progress dialog sonner slider radio-group switch label
npm install -D vitest @vitest/ui inngest-cli
```

In Supabase dashboard:
1. Create new project (region: ap-south-1 / Mumbai)
2. Copy URL + anon key + service role key into `.env.local`
3. Create Storage bucket named `jobs`, set to **private**

### `.env.example`

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### Files to create

```
src/
  lib/supabase.ts          # server client
  lib/supabase-browser.ts  # browser client
  lib/env.ts               # zod-validated env loader
  app/api/health/route.ts  # GET → { ok: true }
  app/api/inngest/route.ts # Inngest serve handler
  inngest/client.ts
  inngest/functions/hello.ts  # logs "hello world"
DECISIONS.md
README.md
```

### Test checklist

- [ ] `npm run dev` → app loads at localhost:3000
- [ ] `curl localhost:3000/api/health` → `{"ok":true}`
- [ ] `npx inngest-cli dev` → Inngest UI at localhost:8288
- [ ] Trigger `hello` from Inngest UI → "hello world" in logs
- [ ] `git push origin main` → Vercel deploys without errors
- [ ] Production `curl https://<app>.vercel.app/api/health` → `{"ok":true}`
- [ ] All env vars set in Vercel dashboard

---

## Phase 1 — Database & Auth

**Goal:** Schema migrated, single-user magic-link auth working, can create/list/read jobs via API.

**Time:** Half a day.

### Deliverables

- SQL migration applied (`jobs`, `scenes`, `api_calls` tables + RLS)
- Magic-link auth via Supabase
- `POST /api/jobs` creates a job
- `GET /api/jobs` lists jobs
- `GET /api/jobs/:id` returns job + scenes
- `DELETE /api/jobs/:id` soft-deletes

### Migration

Create `supabase/migrations/0001_init.sql` with the three tables from PRD §7, plus:
- Indexes on `jobs.user_id`, `jobs.status`, `jobs.created_at desc`, `scenes.job_id`, `api_calls.job_id`
- Unique constraint on `(scenes.job_id, scenes.scene_number)`
- RLS policies: users see only their own jobs/scenes/api_calls
- `updated_at` trigger on `jobs` and `scenes`

Apply with `npx supabase db push`.

### Auth

- Supabase dashboard → Authentication → enable Email magic link
- Invite your email only (single-user allowlist)
- Build `/login` page with magic-link form
- Build `src/middleware.ts` redirecting unauthenticated users to `/login` (except `/login`, `/api/health`, `/api/inngest`)

### Zod schemas

Create `src/lib/schemas.ts`:

```typescript
export const CreateJobSchema = z.object({
  title: z.string().min(1).max(200),
  script: z.string().min(50).max(10000),
  duration_seconds: z.number().int().min(8).max(300).refine(n => n % 8 === 0),
  aspect_ratio: z.enum(['16:9', '9:16']),
  resolution: z.enum(['720p', '1080p']),
  style_guide: z.string().max(1000).optional(),
  auto_mode: z.boolean(),
  veo_model: z.enum(['veo-3-fast', 'veo-3'])
});
```

### Test checklist

- [ ] Migration applied: `select * from jobs limit 1` in Supabase SQL editor works
- [ ] Magic link login works end-to-end
- [ ] Unauthed user hitting `/` redirects to `/login`
- [ ] `POST /api/jobs` with valid body returns 201 + job ID; row visible in Supabase
- [ ] `POST /api/jobs` with `duration_seconds: 10` returns 400
- [ ] `POST /api/jobs` with `script.length < 50` returns 400
- [ ] `GET /api/jobs` returns the new job
- [ ] `GET /api/jobs/<random-uuid>` returns 404 (RLS working)
- [ ] `DELETE /api/jobs/:id` sets status to `cancelled`
- [ ] Vitest: `tests/schemas.test.ts` covers CreateJobSchema edge cases. `npm test` green.

---

## Phase 2 — Pipeline Backbone (Auto Mode Only)

**Goal:** End-to-end pipeline runs in auto mode for a 24-second (3-scene) job. Produces a working `master.mp4`. No UI polish — trigger via curl.

**Time:** 3 days. Hardest phase.

### Deliverables

- 5 Inngest functions (script, prompts, images, videos, stitch) chained via events
- All API integrations working: OpenAI GPT, GPT Image 2, Google Veo 3, FFmpeg
- A real `master.mp4` produced for a 24-second test job
- Every API call logged to `api_calls` with cost

### Inngest structure

```
src/inngest/
  client.ts
  events.ts                    # typed event definitions
  functions/
    job-created.ts             # listens for "job/created", triggers stage 1
    stage-1-script.ts
    stage-2-prompts.ts
    stage-3-images.ts          # fan-out per scene
    stage-4-videos.ts          # fan-out per scene with polling
    stage-5-stitch.ts
```

Each stage uses Inngest `step.run` so individual operations retry independently. On completion, each stage emits the next stage's event (`job/stage-1-complete`, etc.).

### Stage 1 — Script breakdown

- OpenAI `responses` API with structured outputs (PRD §6.1 schema)
- Insert one row in `scenes` table per returned scene
- Log call to `api_calls`
- Emit `job/stage-2-needed`

### Stage 2 — Image prompts

- One OpenAI call passing all scenes, get back `style_anchor` + per-scene `image_prompt`
- Update each scene with `image_prompt = style_anchor + "\n\n" + image_prompt`
- Emit `job/stage-3-needed`

### Stage 3 — Image generation (fan-out)

- For each scene, run an Inngest step that calls GPT Image 2
- Concurrency: 4 (tune later based on tier)
- Save PNG to `jobs/{job_id}/images/{scene_number}.png` in Supabase Storage
- Update `scenes.image_url`
- Emit `job/stage-4-needed` once all scenes have images

### Stage 4 — Video generation (fan-out + polling)

- For each scene, call Veo 3 with image + prompt → get operation ID
- Poll operation every 10s until done (max 10 min)
- Download MP4, save to `jobs/{job_id}/clips/{scene_number}.mp4`
- Update `scenes.clip_url`
- Concurrency: 4
- Emit `job/stage-5-needed` once all clips done

### Stage 5 — Stitching

- Download all clips to temp dir
- Build concat list file
- Run `ffmpeg -f concat -safe 0 -i list.txt -c copy master.mp4`
- On codec mismatch error, fall back to re-encode (`-c:v libx264 -c:a aac`)
- Upload to `jobs/{job_id}/master.mp4`
- Update `jobs.master_video_url`, `jobs.status = 'complete'`, `jobs.completed_at = now()`

**FFmpeg location:** Inngest cloud sandbox may not have ffmpeg. If not, deploy a small Railway service that exposes `POST /stitch` taking a list of signed URLs and returning the master. Decide this on day 1 of Phase 2 — try Inngest first, switch to Railway if blocked.

### Cost tracking helper

Create `src/lib/cost.ts`:

```typescript
export const COSTS = {
  'gpt-5.4': { input_per_1m: ..., output_per_1m: ... },
  'gpt-image-2-high': 0.17,
  'veo-3-fast': 0.15,  // per second
  'veo-3': 0.40
};

export function logApiCall(jobId, sceneId?, provider, model, operation, payload, response, durationMs, status) {
  // compute cost, insert into api_calls, update jobs.cost_usd
}
```

### Test checklist

- [ ] Create a test job: 24 seconds, 3 scenes, auto_mode=true, veo-3-fast, 720p, 16:9. Use curl.
- [ ] Inngest dev UI shows all 5 stages executing in order
- [ ] After stage 1: `scenes` table has 3 rows with voiceover/action filled
- [ ] After stage 2: each scene has `image_prompt` populated
- [ ] After stage 3: 3 PNG files visible in Supabase Storage at `jobs/{id}/images/`
- [ ] After stage 4: 3 MP4 files at `jobs/{id}/clips/` (1.mp4, 2.mp4, 3.mp4). Each plays in browser. Each has audio.
- [ ] After stage 5: `master.mp4` exists in Storage. Downloads and plays. Duration = 24s (±0.1s). Audio is continuous across scene boundaries (no clicks/gaps).
- [ ] `jobs.status = 'complete'`
- [ ] `jobs.cost_usd` matches expected (~$4.16 per PRD §11.2)
- [ ] `api_calls` table has rows for: 1 script, 1 prompts, 3 images, 3 videos = 8 calls
- [ ] Kill the Inngest dev server mid-job, restart it → job resumes from last completed step (Inngest durability test)
- [ ] Force an OpenAI 500 error (use a bad model name) → step retries 3x then surfaces error on `jobs.error_message`

**Stop here and celebrate before moving on. This is 80% of the engineering.**

---

## Phase 3 — Dashboard UI

**Goal:** Browser-based job creation and monitoring with live status updates. No approval mode yet.

**Time:** 2 days.

### Deliverables

- `/` dashboard with job list table
- `/jobs/new` form with live cost estimate
- `/jobs/[id]` detail page with SSE live updates
- Master video player + download
- Confirmation modal for jobs estimated > $50

### Pages

```
src/app/
  page.tsx                      # dashboard, list of jobs
  jobs/new/page.tsx             # creation form
  jobs/[id]/page.tsx            # detail page
  api/jobs/[id]/events/route.ts # SSE stream
```

### Dashboard

- Table: Title, Created, Duration, Status (color-coded pill), Cost, Actions (View, Delete)
- "New Job" button → `/jobs/new`
- Status pill colors: gray (draft), blue (running), yellow (paused/recoverable), green (complete), red (failed)

### New Job Form

- All fields from PRD §4.2
- Live cost estimate updates as user changes duration/model/resolution
- Cost calculation function: `estimateCost({ duration, veo_model })` from `src/lib/cost.ts`
- If estimate > $50, "Generate" button opens confirmation modal showing cost in bold red
- Submit → POST `/api/jobs` → redirect to `/jobs/[id]`

### Job Detail Page

Layout (top to bottom):
- Header: title, status pill, cost-so-far, elapsed time, Cancel button
- Stage 1 panel: shows scenes JSON (read-only for now)
- Stage 2 panel: shows image prompts (read-only)
- Stage 3 panel: grid of images (read-only)
- Stage 4 panel: grid of video clips (read-only, each plays inline)
- Stage 5 panel: master video player + Download button

### SSE for live updates

`GET /api/jobs/[id]/events` returns Server-Sent Events stream. Poll the DB every 2s server-side, push status changes to client. Client uses native `EventSource` API. Reconnect on disconnect.

Alternative simpler approach: TanStack Query with 3s polling interval. Switch to SSE only if polling feels laggy.

### Test checklist

- [ ] Dashboard lists existing jobs from Phase 2 test
- [ ] New Job form: changing duration from 24s → 3min updates cost estimate live
- [ ] New Job form: switching `veo-3-fast` → `veo-3` updates cost
- [ ] Submit with duration=24s, auto_mode=true → redirects to detail page
- [ ] Detail page shows status pill changing from `scripting` → `prompting` → ... → `complete` over ~5min without refresh
- [ ] Scene grids populate progressively as stages complete
- [ ] Master video player loads and plays once stage 5 done
- [ ] Download button downloads the master.mp4
- [ ] $50+ estimate triggers confirmation modal
- [ ] Cancel button on a running job sets status to `cancelled`, stops Inngest function
- [ ] Lighthouse on detail page: ≥ 90 performance score

---

## Phase 4 — Approval Mode

**Goal:** When `auto_mode=false`, pipeline pauses after each stage. User can edit, approve, reject.

**Time:** 2 days.

### Deliverables

- Pause states between every stage
- Editable scenes panel (voiceover, on_screen_action)
- Editable image prompts panel
- Approve / Reject / Edit buttons in UI
- API endpoints: approve, reject, patch scene

### Inngest changes

After each stage, if `jobs.auto_mode = false`:
- Set status to `awaiting_<stage>_approval`
- Use `step.waitForEvent('job/approved', { match: 'data.jobId', timeout: '7d' })` to pause
- On approve event, continue to next stage
- On reject event, re-run current stage from scratch

### API routes

```
POST /api/jobs/:id/approve     # body: { stage: 'script' | 'prompts' | 'images' }
POST /api/jobs/:id/reject      # body: { stage: ... }
PATCH /api/jobs/:id/scenes/:n  # body: { voiceover_text?, on_screen_action?, image_prompt? }
```

Approve fires an Inngest event `job/approved` with `{ jobId, stage }`. Reject fires `job/rejected`.

### UI

- In approval mode, each panel shows **Approve & Continue** and **Reject & Re-run** buttons
- Scene cards have inline edit mode (click pencil icon → textarea → save → PATCH)
- Edits persist immediately; Approve uses the persisted edited values
- Hide approval buttons when `auto_mode = true`

### Test checklist

- [ ] Create job with auto_mode=false, 24s
- [ ] After stage 1, status = `awaiting_script_approval`, Inngest function shows "waiting for event"
- [ ] Edit scene 2's voiceover → PATCH succeeds → DB updated
- [ ] Click Approve → status = `prompting` → stage 2 runs using the edited voiceover
- [ ] After stage 2, edit one image prompt → Approve → stage 3 uses edited prompt
- [ ] Click Reject on stage 2 → status reverts to `scripting`, stage 1 reruns
- [ ] All transitions visible live via SSE/polling
- [ ] Vitest: schema test for PATCH body validation
- [ ] Job in approval mode left untouched for 24h → still resumes correctly when approved (Inngest sleep durability)

---

## Phase 5 — Retry & Recovery

**Goal:** Per-scene retry. Master re-stitches automatically after any scene change.

**Time:** 1.5 days.

### Deliverables

- "Regenerate" button on each image card
- "Retry video" button on each video clip card
- Edit-prompt-and-regenerate flow for images
- `failed_recoverable` job status for partial failures
- Auto re-stitch when any scene clip changes

### API routes

```
POST /api/jobs/:id/scenes/:n/retry
  body: { from_stage: 'image' | 'video', new_prompt?: string }
```

This:
1. If `from_stage = 'image'`: optionally update `image_prompt`, regenerate image, regenerate video for that scene
2. If `from_stage = 'video'`: regenerate video using existing image
3. After scene succeeds, fire `job/restitch-needed` event
4. Stage 5 (stitch) re-runs, overwrites `master.mp4`

### Failure handling

In stage 4, if a Veo call fails with content policy error:
- Mark scene status = `failed`
- Set scene `error_message` to the policy reason
- Set job status = `failed_recoverable`
- Do NOT fail the whole job — let other scenes finish

When user retries that one scene successfully, check if all scenes done → re-trigger stitch.

### UI changes

- Failed scene cards turn red with the error message and a prominent Retry button
- "Edit prompt & regenerate" opens a modal with the current prompt prefilled
- After retry succeeds, master video player reloads with the new master

### Test checklist

- [ ] On a completed job, click Regenerate on scene 2's image → new image generated → new video generated for scene 2 only → master re-stitched
- [ ] Total duration of new master still correct (no off-by-one)
- [ ] Edit prompt + regenerate: new prompt used, persisted to `scenes.image_prompt`
- [ ] Force a Veo failure: create a scene with prompt "extremely violent gory scene" → policy reject → scene marked failed → other scenes succeed → job status = `failed_recoverable`
- [ ] Retry the failed scene with a tame prompt → succeeds → job goes to `complete`
- [ ] Cost continues to accumulate correctly across retries
- [ ] Concurrent retries on different scenes both succeed without race conditions

---

## Phase 6 — Cost Guardrails & Polish

**Goal:** Production-ready. Won't accidentally bankrupt you. Errors observable.

**Time:** 1.5 days.

### Deliverables

- Pre-flight cost cap enforcement (default $100/job)
- Monthly spend cap enforcement (default $500)
- Bundle zip download
- Sentry integration
- Structured logging
- Runbook for failure modes

### Cost caps

Settings (env vars or hardcoded constants for v1):
- `MAX_JOB_COST_USD = 100`
- `MAX_MONTHLY_SPEND_USD = 500`

`POST /api/jobs` runs pre-flight check:
- Estimate cost from inputs
- If > `MAX_JOB_COST_USD`, return 400 with override hint
- Query sum of `jobs.cost_usd` for current month
- If `current_month + estimate > MAX_MONTHLY_SPEND_USD`, return 400

### Bundle download

`GET /api/jobs/:id/download?format=zip`:
- Build a zip server-side containing `master.mp4` + `clips/*.mp4` + `images/*.png` + `script.json`
- Stream to client with proper Content-Disposition

### Sentry

`npm install @sentry/nextjs` → `npx @sentry/wizard@latest -i nextjs`. Wrap Inngest functions in try/catch and `Sentry.captureException`.

### Logging

Use `console.log` with structured JSON. Vercel ingests it automatically. Fields: `level`, `event`, `job_id`, `scene_id`, `duration_ms`. Optional later: pipe to Axiom.

### Runbook

Create `RUNBOOK.md` with:
- "Veo 3 is rate-limited" → how to back off
- "Inngest function stuck" → how to manually fail/restart
- "Storage quota hit" → which jobs to purge
- "Cost cap blocking real work" → how to override

### Test checklist

- [ ] Create job estimated at $120 → returns 400 with cost-cap error
- [ ] After running jobs totaling $480 this month, new $30 job → 400 (monthly cap)
- [ ] Bundle download zip contains all expected files, plays after extract
- [ ] Force an uncaught error in stage 3 → appears in Sentry within 1 min
- [ ] `RUNBOOK.md` walks through each known failure mode

---

## Phase 7 — Production Hardening

**Goal:** Ready for daily use. Storage cleanup, retention, observability.

**Time:** 1 day.

### Deliverables

- 30-day storage auto-purge (cron)
- "Star" jobs to exempt from purge
- Job-list filter by status
- Vercel cron job for nightly purge
- README with full setup instructions

### Storage retention

Add column: `jobs.starred boolean default false`.

Cron at `src/app/api/cron/purge/route.ts` (Vercel Cron):
- Find jobs where `completed_at < now() - 30 days` AND `starred = false`
- Delete Storage files at `jobs/{id}/`
- Mark `jobs.master_video_url = null`, add `purged_at` timestamp
- Keep DB row for cost history

`vercel.json`:
```json
{
  "crons": [{ "path": "/api/cron/purge", "schedule": "0 3 * * *" }]
}
```

### Test checklist

- [ ] Manually run purge endpoint → only old non-starred jobs lose their files
- [ ] Starred job survives purge
- [ ] Cron triggers in Vercel dashboard schedule
- [ ] README documents: clone → install → env setup → migrations → deploy
- [ ] Fresh-environment test: clone repo on a new machine, follow README, end-to-end works

---

## Final Checklist Before Daily Use

Run all of these in production before declaring "done":

- [ ] Generate a 24s job in auto mode → complete in < 8 min
- [ ] Generate a 1min job in auto mode → complete in < 15 min
- [ ] Generate a 3min job in approval mode → walk through each stage with edits
- [ ] Generate a 3min job in auto mode → complete in < 30 min
- [ ] Cost-tracking accuracy: actual `jobs.cost_usd` within 5% of pre-flight estimate
- [ ] At least one forced failure recovered via retry
- [ ] One starred job, one regular job → wait 30+ days → only regular gets purged
- [ ] No Sentry errors over a clean test week
- [ ] Total infra cost (Vercel + Supabase + Inngest) under $25/month at this volume

---

## What's NOT in this plan (intentionally)

These are deferred to v2. Don't scope-creep into them:

- Character / face consistency across scenes (image-as-reference chaining)
- Subtitles / captions
- Background music overlay
- Manual timeline editing
- Multi-user / sharing
- Mobile app
- Public API for external integrations
- Batch job submission (CSV upload of multiple scripts)

Ship v1 first. Use it for a month. Then decide what's actually worth building next.
