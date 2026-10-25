-- The light view and two indexes (2026-10-25, Nirav: "optimise the data and the API calls"). Run once in the
-- Supabase SQL editor, after schema.sql. Safe to run again. Nothing is changed or removed: a view is a saved query.
--
-- review_comments_light is review_comments without the app snapshot each comment carries (about half of every row);
-- only its short values stay (the drawer's "Go to" reads two of them). The extension and the dev server read the open
-- comments from it, and the approved ones only when the Approved view opens. Writes still read the full table.
-- security_invoker: the view keeps the table's row rules (hub/roles.sql), it never sees more than the reader may.

create or replace view public.review_comments_light with (security_invoker = true) as
select
  id, project, ts, status, approved_at, shot, thumb, updated_at, author,
  case
    when jsonb_typeof(data -> 'app') = 'object' then
      (data - 'app') || jsonb_build_object('app', coalesce(
        (select jsonb_object_agg(k, v) from jsonb_each(data -> 'app') as e(k, v) where length(v::text) <= 80),
        '{}'::jsonb))
    else data
  end as data
from public.review_comments;

grant select on public.review_comments_light to anon, authenticated;

-- the two questions the drawer now asks most: "what changed last, and how many are there" and "the ids in order"
create index if not exists review_comments_project_updated on public.review_comments (project, updated_at desc);
create index if not exists review_comments_project_ts on public.review_comments (project, ts);
