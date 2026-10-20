-- Members and invitations: any reader can invite people from the Members page, and
-- everyone sees who has joined and who is still invited. Run after 003 (safe to re-run).
--
-- Invitations are sent by the "invite" Edge Function (supabase/functions/invite), which
-- holds the service key. Readers only read this table; the function and
-- scripts/invite.py write it.

create table if not exists invites (
  email        text primary key check (email = lower(email) and char_length(email) <= 254),
  user_id      uuid references auth.users (id) on delete cascade,
  invited_by   uuid references readers (user_id) on delete set null,  -- null = the chapter lead's script
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz not null default now()
);

create index if not exists invites_invited_by on invites (invited_by, created_at);

alter table invites enable row level security;
revoke all on invites from anon;

drop policy if exists invites_read on invites;
create policy invites_read on invites for select to authenticated using (true);

-- Lets the invite function find an existing account by email (service key only)
create or replace function auth_user_id(p_email text) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select id from auth.users where lower(email) = lower(p_email) limit 1 $$;
revoke execute on function auth_user_id(text) from public, anon, authenticated;
grant execute on function auth_user_id(text) to service_role;

-- Live updates (the page subscribes to this table, so it must be listed)
do $$
begin
  alter publication supabase_realtime add table invites;
exception when duplicate_object then null;
end $$;
