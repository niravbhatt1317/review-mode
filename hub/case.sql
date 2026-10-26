-- GitHub handles ignore case (2026-10-26). Nikhil signed in as "Nikhil482008" while the team list had "nikhil482008",
-- so he landed on the waiting list. Run once in the Supabase SQL editor, after roles.sql. Safe to run again.
-- Every check now compares handles in lower case; the stray waiting rows of people already on the team go.

-- 1. a waiting (or refused) row whose person is already a member or an approver, in any case: removed
delete from public.review_members w
where w.role in ('waiting', 'refused')
  and exists (
    select 1 from public.review_members m
    where lower(m.handle) = lower(w.handle) and m.handle <> w.handle and m.role in ('approver', 'member')
  );

-- 2. the checks, case-blind
create or replace function public.review_is_approver() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.review_members where lower(handle) = lower(public.review_me()) and role = 'approver')
$$;
create or replace function public.review_is_member() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.review_members where lower(handle) = lower(public.review_me()) and role in ('approver', 'member'))
$$;
create or replace function public.review_allowed(act text, st text, auth text, asg text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.review_me() is not null and not public.review_is_member() then false
    when public.review_is_approver() then true
    when not exists (select 1 from public.review_rules where action = act and signed) then true
    else exists (
      select 1 from public.review_rules r
      where r.action = act and (r.statuses is null or st = any (r.statuses)) and (
        r.who = 'anyone'
        or (r.who = 'member' and public.review_is_member())
        or (r.who = 'author' and auth is not null and lower(auth) = lower(public.review_me()))
        or (r.who = 'assignee' and asg is not null and lower(asg) = lower(public.review_me()))))
  end
$$;

-- 3. someone signing in joins the waiting list only if no case twin of them is listed
create or replace function public.review_join_waiting() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.review_members where lower(handle) = lower(new.handle)) then
    insert into public.review_members (handle, role) values (new.handle, 'waiting') on conflict (handle) do nothing;
  end if;
  return new;
end $$;
