-- ============================================================
-- 0001_init.sql  —  Script-to-Video Pipeline initial schema
-- ============================================================

-- ── jobs ────────────────────────────────────────────────────
create table public.jobs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  title             text not null,
  script            text not null,
  duration_seconds  int  not null check (duration_seconds % 8 = 0 and duration_seconds between 8 and 300),
  aspect_ratio      text not null default '16:9' check (aspect_ratio in ('16:9','9:16')),
  resolution        text not null default '720p'  check (resolution in ('720p','1080p')),
  style_guide       text,
  auto_mode         boolean not null default false,
  veo_model         text not null default 'veo-3-fast' check (veo_model in ('veo-3-fast','veo-3')),
  status            text not null default 'draft' check (status in (
                      'draft','scripting','awaiting_script_approval',
                      'prompting','awaiting_prompt_approval',
                      'imaging','awaiting_image_approval',
                      'videoing','stitching','complete',
                      'failed','failed_recoverable','cancelled'
                    )),
  cost_usd          numeric(10,4) not null default 0,
  error_message     text,
  master_video_url  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index jobs_user_id_idx       on public.jobs(user_id);
create index jobs_status_idx        on public.jobs(status);
create index jobs_created_at_idx    on public.jobs(created_at desc);

-- ── scenes ──────────────────────────────────────────────────
create table public.scenes (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.jobs(id) on delete cascade,
  scene_number      int  not null,
  start_time        int  not null,
  end_time          int  not null,
  voiceover_text    text not null default '',
  on_screen_action  text not null default '',
  visual_keywords   text[] not null default '{}',
  image_prompt      text,
  image_url         text,
  clip_url          text,
  veo_operation_id  text,
  status            text not null default 'pending' check (status in ('pending','imaging','videoing','done','failed')),
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (job_id, scene_number)
);

create index scenes_job_id_idx on public.scenes(job_id);

-- ── api_calls ────────────────────────────────────────────────
create table public.api_calls (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.jobs(id) on delete cascade,
  scene_id         uuid references public.scenes(id) on delete set null,
  provider         text not null check (provider in ('openai','google')),
  model            text not null,
  operation        text not null check (operation in ('script','prompts','image','video')),
  cost_usd         numeric(10,4) not null default 0,
  duration_ms      int,
  request_payload  jsonb,
  response_payload jsonb,
  status           text not null default 'success' check (status in ('success','error')),
  error_code       text,
  created_at       timestamptz not null default now()
);

create index api_calls_job_id_idx on public.api_calls(job_id);

-- ── updated_at trigger ───────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger jobs_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

create trigger scenes_updated_at
  before update on public.scenes
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────
alter table public.jobs       enable row level security;
alter table public.scenes     enable row level security;
alter table public.api_calls  enable row level security;

-- jobs: owner-only
create policy "jobs_select" on public.jobs for select using (auth.uid() = user_id);
create policy "jobs_insert" on public.jobs for insert with check (auth.uid() = user_id);
create policy "jobs_update" on public.jobs for update using (auth.uid() = user_id);
create policy "jobs_delete" on public.jobs for delete using (auth.uid() = user_id);

-- scenes: via job ownership
create policy "scenes_select" on public.scenes for select
  using (exists (select 1 from public.jobs where id = scenes.job_id and user_id = auth.uid()));
create policy "scenes_insert" on public.scenes for insert
  with check (exists (select 1 from public.jobs where id = scenes.job_id and user_id = auth.uid()));
create policy "scenes_update" on public.scenes for update
  using (exists (select 1 from public.jobs where id = scenes.job_id and user_id = auth.uid()));
create policy "scenes_delete" on public.scenes for delete
  using (exists (select 1 from public.jobs where id = scenes.job_id and user_id = auth.uid()));

-- api_calls: via job ownership
create policy "api_calls_select" on public.api_calls for select
  using (exists (select 1 from public.jobs where id = api_calls.job_id and user_id = auth.uid()));
create policy "api_calls_insert" on public.api_calls for insert
  with check (exists (select 1 from public.jobs where id = api_calls.job_id and user_id = auth.uid()));
