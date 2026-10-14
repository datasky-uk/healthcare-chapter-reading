-- Reading tracker schema. Run once in the Supabase SQL editor (safe to re-run),
-- then run 002_added_papers_and_materials.sql.
-- Everything requires a signed-in, invited user. Bibliography papers are written
-- only with the service key (scripts/seed.py); readers write only their own rows.

create table if not exists papers (
  id            text primary key,
  section       int  not null,
  section_title text,
  rank          int unique,
  tag           text not null check (tag in ('essential', 'should', 'mildly', 'reference')),
  short_cite    text,
  why_read      text,
  title         text,
  citation      text not null,
  doi           text,
  url           text,
  is_oa         boolean not null default false,
  oa_status     text,
  oa_url        text,
  pdf_url       text,
  verify_flag   text not null default 'verified'
                check (verify_flag in ('verified', 'preprint', 'partly', 'unverified')),
  check_notes   text[] not null default '{}',
  updated_at    timestamptz not null default now()
);

create table if not exists readers (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  affiliation  text check (char_length(affiliation) <= 160),
  created_at   timestamptz not null default now()
);

create table if not exists claims (
  paper_id   text not null references papers (id) on delete cascade,
  user_id    uuid not null references readers (user_id) on delete cascade,
  status     text not null default 'claimed' check (status in ('claimed', 'reading', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (paper_id, user_id)
);

create table if not exists notes (
  paper_id         text not null references papers (id) on delete cascade,
  user_id          uuid not null references readers (user_id) on delete cascade,
  key_finding      text,
  design_sample    text,
  key_numbers      text,
  numbers_verified boolean not null default false,
  limitations      text,
  chapter_section  int check (chapter_section between 1 and 9),
  chapter_use      text,
  suggested_tag    text check (suggested_tag in ('essential', 'should', 'mildly', 'reference')),
  quotable         text,
  updated_at       timestamptz not null default now(),
  primary key (paper_id, user_id)
);

create table if not exists suggestions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references readers (user_id) on delete cascade,
  citation   text not null check (char_length(citation) between 3 and 1000),
  doi        text,
  section    int check (section between 1 and 9),
  why        text,
  status     text not null default 'open' check (status in ('open', 'added', 'declined')),
  created_at timestamptz not null default now()
);

-- Keep updated_at current
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists claims_touch on claims;
create trigger claims_touch before update on claims for each row execute function touch_updated_at();
drop trigger if exists notes_touch on notes;
create trigger notes_touch before update on notes for each row execute function touch_updated_at();

-- Reader limit: two readers for essential papers, one for everything else
create or replace function enforce_claim_limit() returns trigger language plpgsql as $$
declare
  paper_tag text;
  taken int;
begin
  perform pg_advisory_xact_lock(hashtext(new.paper_id));
  select tag into paper_tag from papers where id = new.paper_id;
  select count(*) into taken from claims where paper_id = new.paper_id;
  if taken >= (case when paper_tag = 'essential' then 2 else 1 end) then
    raise exception 'This paper already has all its readers' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists claims_limit on claims;
create trigger claims_limit before insert on claims for each row execute function enforce_claim_limit();

-- Row-level security
alter table papers      enable row level security;
alter table readers     enable row level security;
alter table claims      enable row level security;
alter table notes       enable row level security;
alter table suggestions enable row level security;

revoke all on papers, readers, claims, notes, suggestions from anon;

drop policy if exists papers_read on papers;
create policy papers_read on papers for select to authenticated using (true);

drop policy if exists readers_read on readers;
create policy readers_read on readers for select to authenticated using (true);
drop policy if exists readers_insert on readers;
create policy readers_insert on readers for insert to authenticated with check (user_id = auth.uid());
drop policy if exists readers_update on readers;
create policy readers_update on readers for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists claims_read on claims;
create policy claims_read on claims for select to authenticated using (true);
drop policy if exists claims_insert on claims;
create policy claims_insert on claims for insert to authenticated with check (user_id = auth.uid());
drop policy if exists claims_update on claims;
create policy claims_update on claims for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists claims_delete on claims;
create policy claims_delete on claims for delete to authenticated using (user_id = auth.uid());

drop policy if exists notes_read on notes;
create policy notes_read on notes for select to authenticated using (true);
drop policy if exists notes_insert on notes;
create policy notes_insert on notes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists notes_update on notes;
create policy notes_update on notes for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notes_delete on notes;
create policy notes_delete on notes for delete to authenticated using (user_id = auth.uid());

drop policy if exists suggestions_read on suggestions;
create policy suggestions_read on suggestions for select to authenticated using (true);
drop policy if exists suggestions_insert on suggestions;
create policy suggestions_insert on suggestions for insert to authenticated with check (user_id = auth.uid());

-- Live updates in the page
do $$
begin
  alter publication supabase_realtime add table claims, notes, readers, suggestions;
exception when duplicate_object then null;
end $$;
