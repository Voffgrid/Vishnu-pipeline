# Vishnu — Script-to-Video Pipeline

Internal web app that turns a script + target duration into a stitched MP4 with audio via a 4-stage AI pipeline (GPT → GPT Image 2 → Veo 3 → FFmpeg).

See [prd.md](prd.md) for the product spec and [PLAN.md](PLAN.md) for the phased build plan. Phase decisions are logged in [DECISIONS.md](DECISIONS.md).

## Stack

- **Next.js 16** (App Router, TypeScript) on Vercel
- **Tailwind v4** + **shadcn/ui**
- **Supabase** — Postgres + Storage + Auth (magic link)
- **Inngest** — durable worker for the pipeline (outside Vercel's 800s cap)
- **OpenAI** — `gpt-5.4` (script + prompts), `gpt-image-2` (anchor stills)
- **Google Gemini API** — Veo 3 Fast (default) for video generation
- **FFmpeg** — concat-demuxer stitching in the worker

## Local setup (Phase 0)

```bash
npm install
cp .env.example .env.local
# Fill in Supabase + OpenAI + Gemini keys
npm run dev
```

In a second terminal, run the Inngest dev server:

```bash
npx inngest-cli dev
```

- App: http://localhost:3000
- Health: http://localhost:3000/api/health
- Inngest UI: http://localhost:8288

## Project layout

```
src/
  app/
    api/
      health/route.ts      # liveness check
      inngest/route.ts     # Inngest serve handler
  components/ui/           # shadcn primitives
  inngest/
    client.ts              # Inngest app client
    functions/
      hello.ts             # smoke test
  lib/
    env.ts                 # zod-validated env loader
    supabase.ts            # server + service-role clients
    supabase-browser.ts    # browser client
```
