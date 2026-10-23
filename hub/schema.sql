-- The review hub on Supabase: run once in the project's SQL Editor (Nirav, owner rights).
-- Safe to run again: everything is "if not exists" or replaced.
--
-- One table of comments, one private bucket of pictures. Each comment keeps its whole record as JSON (the same shape
-- the local collector writes), with the few columns the hub needs to sort, filter and sweep as real columns.
-- Projects are a name; this repo uses the one in .review/hub.json.

create table if not exists public.review_comments (
  id          text primary key,
  project     text not null,
  ts          bigint not null,                 -- creation time, ms; the number is the position by ts
  status      text not null default 'open' check (status in ('open', 'progress', 'approval', 'approved')),
  approved_at timestamptz,                     -- set when status becomes approved; the sweep reads it
  shot        boolean not null default false,  -- a full picture exists in the bucket (<project>/<id>.png)
  thumb       boolean not null default false,  -- a thumbnail exists (<project>/<id>.t.jpg)
  data        jsonb not null,                  -- the comment as the collector knows it
  updated_at  timestamptz not null default now()
);
create index if not exists review_comments_project_ts on public.review_comments (project, ts);
create index if not exists review_comments_sweep on public.review_comments (status, approved_at) where shot;

-- updated_at kept by the database
create or replace function public.review_touch() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists review_comments_touch on public.review_comments;
create trigger review_comments_touch before update on public.review_comments
  for each row execute function public.review_touch();

-- Access: the publishable key may read and write comments and pictures. Row rules are on, so the day sign-in
-- arrives the policies below change to "authenticated" and nothing else moves.
alter table public.review_comments enable row level security;
drop policy if exists "review: team reads" on public.review_comments;
drop policy if exists "review: team writes" on public.review_comments;
drop policy if exists "review: team edits" on public.review_comments;
drop policy if exists "review: team removes" on public.review_comments;
create policy "review: team reads"   on public.review_comments for select to anon, authenticated using (true);
create policy "review: team writes"  on public.review_comments for insert to anon, authenticated with check (true);
create policy "review: team edits"   on public.review_comments for update to anon, authenticated using (true) with check (true);
create policy "review: team removes" on public.review_comments for delete to anon, authenticated using (true);

-- Live updates: the table is published, so clients can subscribe to changes
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'review_comments') then
    alter publication supabase_realtime add table public.review_comments;
  end if;
end $$;

-- The pictures: a private bucket, 12 MB per file, PNG and JPEG only
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-shots', 'review-shots', false, 12582912, array['image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 12582912, allowed_mime_types = array['image/png', 'image/jpeg'];

drop policy if exists "review shots: team reads"   on storage.objects;
drop policy if exists "review shots: team writes"  on storage.objects;
drop policy if exists "review shots: team edits"   on storage.objects;
drop policy if exists "review shots: team removes" on storage.objects;
create policy "review shots: team reads"   on storage.objects for select to anon, authenticated using (bucket_id = 'review-shots');
create policy "review shots: team writes"  on storage.objects for insert to anon, authenticated with check (bucket_id = 'review-shots');
create policy "review shots: team edits"   on storage.objects for update to anon, authenticated using (bucket_id = 'review-shots') with check (bucket_id = 'review-shots');
create policy "review shots: team removes" on storage.objects for delete to anon, authenticated using (bucket_id = 'review-shots');

-- The storage meter: how much the bucket holds, in bytes, per project
create or replace function public.review_usage()
returns table (project text, files bigint, bytes bigint)
language sql security definer set search_path = public, storage as $$
  select split_part(name, '/', 1) as project, count(*) as files,
         coalesce(sum((metadata ->> 'size')::bigint), 0) as bytes
  from storage.objects
  where bucket_id = 'review-shots'
  group by 1
$$;
grant execute on function public.review_usage() to anon, authenticated;

-- What the sweep needs: the pictures of comments approved more than 14 days ago. The collector deletes those files
-- through the storage API (deleting storage rows from SQL would leave the files behind) and then clears the flags.
create or replace function public.review_sweepable(days integer default 14)
returns table (id text, project text)
language sql security definer set search_path = public as $$
  select id, project from public.review_comments
  where status = 'approved' and approved_at < now() - make_interval(days => days) and (shot or thumb)
$$;
grant execute on function public.review_sweepable(integer) to anon, authenticated;
