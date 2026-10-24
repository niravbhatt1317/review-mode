-- Who may approve and who may delete (2026-10-24). Run once in the Supabase SQL editor, after schema.sql and
-- people.sql. Safe to run again.
--
-- The rules live in the review_rules table below (edit a row to change one); as shipped:
--   approve   only an approver (review_members.role = 'approver'), signed in with GitHub; send back and reopen too
--   delete    the comment's author while nobody has picked it up, or an approver, signed in with GitHub
--   pick up   the first one wins; a second pick-up a moment later is refused
--   hand over the person on it (signed in) or an approver passes it to someone else
--   take back whoever did it pulls it back from For approval to In progress, until the approver acts
--   questions anyone answers; the asker follows up or closes it (Got it); an approver closes any
--   the rest  (add, pick up, done, put back, edit) stays open, so the dev server, `npx review` and Claude keep
--             working with the publishable key
--
-- Members: the team, by GitHub handle. 'approver' approves and deletes anything; 'member' deletes their own;
-- 'waiting': signed in from outside the team, waiting for an approver; 'refused': an approver said no.

create table if not exists public.review_members (
  handle    text primary key,
  role      text not null default 'member' check (role in ('approver', 'member', 'waiting', 'refused')),
  added_at  timestamptz not null default now()
);
alter table public.review_members enable row level security;
drop policy if exists "review members: everyone reads" on public.review_members;
create policy "review members: everyone reads" on public.review_members for select to anon, authenticated using (true);

insert into public.review_members (handle, role) values
  ('niravbhatt1317', 'approver'),
  ('pranjalgupta-motadata', 'member'),
  ('kisu1311', 'member'),
  ('zenichakalasiya', 'member'),
  ('ronak-patel-motadata', 'member'),
  ('nikhil482008', 'member')
on conflict (handle) do nothing;

-- the signed-in person's GitHub handle, from the session the hub issued; null for the publishable key alone
create or replace function public.review_me() returns text language sql stable as $$
  select nullif(coalesce(auth.jwt() -> 'user_metadata' ->> 'user_name', auth.jwt() -> 'user_metadata' ->> 'preferred_username'), '')
$$;
create or replace function public.review_is_approver() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.review_members where handle = public.review_me() and role = 'approver')
$$;
-- a table made by an earlier run of this script: let 'refused' in too
alter table public.review_members drop constraint if exists review_members_role_check;
alter table public.review_members add constraint review_members_role_check check (role in ('approver', 'member', 'waiting', 'refused'));
create or replace function public.review_is_member() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.review_members where handle = public.review_me() and role in ('approver', 'member'))
$$;
grant execute on function public.review_is_member() to anon, authenticated;
grant execute on function public.review_me() to anon, authenticated;
grant execute on function public.review_is_approver() to anon, authenticated;

-- the author of each comment, kept in a column of its own: the signed-in handle when there is one, else the name the
-- writer gave (data.by)
alter table public.review_comments add column if not exists author text;
update public.review_comments set author = data ->> 'by' where author is null;
create or replace function public.review_set_author() returns trigger language plpgsql as $$
begin
  new.author := coalesce(public.review_me(), new.data ->> 'by');
  return new;
end $$;
drop trigger if exists review_comments_author on public.review_comments;
create trigger review_comments_author before insert on public.review_comments
  for each row execute function public.review_set_author();

-- THE RULES (2026-10-24): who may do what, as rows, so a change is an edit here, not a new extension. The drawer reads
-- this table to show or hide its buttons (within a minute); the hub checks it on every change.
--   action    pick_up, put_back, done, approve, send_back, take_back, reopen, hand_over, assign, edit, change_type,
--             remove; for questions answer, follow_up, resolve
--   who       anyone | member | author | assignee | approver   (an approver may always do everything)
--   statuses  the states it applies in (null: any)
--   signed    true: needs a GitHub sign-in and the hub refuses anyone else; false: the drawer shows or hides it only, so
--             the dev server, `npx review` and Claude (which act without a sign-in) can still do it
create table if not exists public.review_rules (
  action    text not null,
  who       text not null check (who in ('anyone', 'member', 'author', 'assignee', 'approver')),
  statuses  text[],
  signed    boolean not null default false,
  primary key (action, who)
);
alter table public.review_rules enable row level security;
drop policy if exists "review rules: everyone reads" on public.review_rules;
create policy "review rules: everyone reads" on public.review_rules for select to anon, authenticated using (true);

-- today's rules; a row already there is left as you set it
insert into public.review_rules (action, who, statuses, signed) values
  ('pick_up',     'anyone',   '{open}',       false),
  ('put_back',    'assignee', '{progress}',   false),
  ('done',        'assignee', '{progress}',   false),
  ('approve',     'approver', null,           true),
  ('send_back',   'approver', '{approval}',   true),
  ('take_back',   'assignee', '{approval}',   false),
  ('answer',      'anyone',   null,           false),
  ('follow_up',   'author',   null,           false),
  ('resolve',     'author',   '{open,progress,approval}', false),
  ('reopen',      'approver', '{approved}',   true),
  ('hand_over',   'assignee', '{progress}',   true),
  ('assign',      'approver', '{open}',       true),
  ('edit',        'author',   null,           false),
  ('change_type', 'anyone',   null,           false),
  ('remove',      'author',   '{open}',       true)
on conflict (action, who) do nothing;

-- may the signed-in person do this? An approver always; a rule nobody marked as signed lets everyone through (the
-- drawer is its only gate); otherwise one of the action's rows must match the comment's state and the person.
create or replace function public.review_allowed(act text, st text, auth text, asg text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.review_me() is not null and not public.review_is_member() then false -- signed in, on the waiting list
    when public.review_is_approver() then true
    when not exists (select 1 from public.review_rules where action = act and signed) then true
    else exists (
      select 1 from public.review_rules r
      where r.action = act and (r.statuses is null or st = any (r.statuses)) and (
        r.who = 'anyone'
        or (r.who = 'member' and exists (select 1 from public.review_members m where m.handle = public.review_me() and m.role <> 'waiting'))
        or (r.who = 'author' and auth is not null and auth = public.review_me())
        or (r.who = 'assignee' and asg is not null and asg = public.review_me())))
  end
$$;
grant execute on function public.review_allowed(text, text, text, text) to anon, authenticated;

-- every change: work out which action it is, check the rules, keep the author, and let the first pick-up win
create or replace function public.review_guard() returns trigger language plpgsql as $$
declare
  act text;
  asg text := old.data ->> 'assignee';
  isq boolean := coalesce(old.data ->> 'severity', '') in ('question', 'idea');
  -- the step this change added, if it added one (a reply, a take back)
  step jsonb := case when jsonb_array_length(coalesce(new.data -> 'history', '[]')) > jsonb_array_length(coalesce(old.data -> 'history', '[]'))
                     then new.data -> 'history' -> -1 end;
begin
  if (new.data ->> 'severity') is distinct from (old.data ->> 'severity') then
    -- first: a question made into a fix also starts over as New, which is part of the same change
    act := 'change_type';
  elsif step ->> 'kind' = 'reply' then
    -- the question flow: someone answers (to Answered), or the asker follows up (back to Asked)
    act := case when new.status = 'open' and isq then 'follow_up' else 'answer' end;
  elsif (new.data ->> 'handedAt') is distinct from (old.data ->> 'handedAt') then
    act := case when old.status = 'open' then 'assign' else 'hand_over' end;
  elsif new.status is distinct from old.status then
    act := case
      when new.status = 'approved' and isq then 'resolve'
      when new.status = 'approved' then 'approve'
      when old.status = 'approved' then 'reopen'
      -- from For approval back to In progress: the doer taking it back (the step says so) or the approver sending it back
      when old.status = 'approval' then case when new.data -> 'history' -> -1 ->> 'kind' = 'take' then 'take_back' else 'send_back' end
      when old.status = 'progress' and new.status = 'approval' then 'done'
      when old.status = 'progress' and new.status = 'open' then 'put_back'
      when old.status = 'open' then 'pick_up'
      else null end;
  elsif (new.data ->> 'text') is distinct from (old.data ->> 'text') then
    act := 'edit';
  end if;
  if act is not null and not public.review_allowed(act, old.status, old.author, asg) then
    raise exception 'Not allowed: %', replace(act, '_', ' ') using errcode = '42501';
  end if;
  -- a second pick-up landing a moment late (in progress, someone else named, not a hand-over): the first one wins
  if act is null and old.status = 'progress' and new.status = 'progress'
     and coalesce(new.data ->> 'assignee', '') is distinct from coalesce(asg, '')
     and not public.review_is_approver() then
    raise exception 'Already picked up by %', coalesce(asg, 'someone') using errcode = '42501';
  end if;
  new.author := old.author;
  return new;
end $$;
drop trigger if exists review_comments_guard on public.review_comments;
create trigger review_comments_guard before update on public.review_comments
  for each row execute function public.review_guard();

-- removing: by the rules too
drop policy if exists "review: team removes" on public.review_comments;
drop policy if exists "review: author or approver removes" on public.review_comments;
drop policy if exists "review: removes by the rules" on public.review_comments;
create policy "review: removes by the rules" on public.review_comments for delete to anon, authenticated
  using (public.review_allowed('remove', status, author, data ->> 'assignee'));

-- THE WAITING LIST (2026-10-24). Whoever signs in with GitHub and is not on the list above joins it as 'waiting'; an
-- approver lets them in ('member') or refuses them ('refused') from the drawer. A signed-in person who is not a member
-- reads and writes nothing. The publishable key alone (the dev server, `npx review`, Claude) stays as it was: closing
-- that is the later "lock the hub to signed-in users" step.
create or replace function public.review_join_waiting() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.review_members (handle, role) values (new.handle, 'waiting') on conflict (handle) do nothing;
  return new;
end $$;
drop trigger if exists review_people_join on public.review_people;
create trigger review_people_join after insert on public.review_people
  for each row execute function public.review_join_waiting();
-- people who signed in before this script ran and are not on the list: waiting too
insert into public.review_members (handle, role)
  select handle, 'waiting' from public.review_people on conflict (handle) do nothing;

drop policy if exists "review members: approvers decide" on public.review_members;
create policy "review members: approvers decide" on public.review_members for update to authenticated
  using (public.review_is_approver()) with check (public.review_is_approver());

-- comments: the publishable key as before; a signed-in person only as a member
drop policy if exists "review: team reads"   on public.review_comments;
drop policy if exists "review: team writes"  on public.review_comments;
drop policy if exists "review: team edits"   on public.review_comments;
drop policy if exists "review: key reads"    on public.review_comments;
drop policy if exists "review: key writes"   on public.review_comments;
drop policy if exists "review: key edits"    on public.review_comments;
drop policy if exists "review: members read"  on public.review_comments;
drop policy if exists "review: members write" on public.review_comments;
drop policy if exists "review: members edit"  on public.review_comments;
create policy "review: key reads"     on public.review_comments for select to anon using (true);
create policy "review: key writes"    on public.review_comments for insert to anon with check (true);
create policy "review: key edits"     on public.review_comments for update to anon using (true) with check (true);
create policy "review: members read"  on public.review_comments for select to authenticated using (public.review_is_member());
create policy "review: members write" on public.review_comments for insert to authenticated with check (public.review_is_member());
create policy "review: members edit"  on public.review_comments for update to authenticated using (public.review_is_member()) with check (public.review_is_member());
