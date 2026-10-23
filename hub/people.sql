-- The people of the hub: who has signed in, with the name and picture GitHub gave. Filled by the extension on each
-- sign-in; read by every browser to show names and pictures on comments. Run once in the SQL Editor.

create table if not exists public.review_people (
  handle     text primary key,          -- the GitHub handle, what comments record as "by"
  name       text not null,
  avatar     text,
  user_id    uuid,                       -- the auth user, when signed in
  seen_at    timestamptz not null default now()
);
alter table public.review_people enable row level security;
drop policy if exists "review people: everyone reads" on public.review_people;
drop policy if exists "review people: signed-in writes own" on public.review_people;
drop policy if exists "review people: signed-in updates own" on public.review_people;
create policy "review people: everyone reads" on public.review_people for select to anon, authenticated using (true);
create policy "review people: signed-in writes own" on public.review_people for insert to authenticated with check (auth.uid() = user_id);
create policy "review people: signed-in updates own" on public.review_people for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
