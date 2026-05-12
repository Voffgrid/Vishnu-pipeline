-- Create the assets storage bucket (private — admin client writes, signed URLs serve reads).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'assets',
  'assets',
  false,
  52428800,  -- 50 MB per file
  array['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'application/zip']
)
on conflict (id) do nothing;

-- Service role bypasses RLS, so no policy needed for the worker.
-- This policy lets authenticated users read their own job assets via signed URLs.
create policy "assets_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] = 'jobs'
    and exists (
      select 1 from public.jobs
      where id::text = (storage.foldername(name))[2]
        and user_id = auth.uid()
    )
  );
