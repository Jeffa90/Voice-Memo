-- Pin the search_path so the function can't be hijacked by a role-local schema.
create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$ begin new.updated_at = now(); return new; end $$;

-- handle_new_user is a trigger function only. Nothing should reach it over REST RPC.
revoke execute on function public.handle_new_user() from anon, authenticated, public;

-- user_org_ids must stay executable by `authenticated`: RLS policies call it as
-- the querying role. Signed-out callers have no auth.uid(), so it could only ever
-- return their own orgs — but anon has no reason to reach it at all.
revoke execute on function public.user_org_ids() from anon, public;
grant execute on function public.user_org_ids() to authenticated;
