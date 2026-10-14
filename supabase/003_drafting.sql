-- Writing the chapter: AI drafts, readers check claims, edit and approve sections,
-- and readers can share PDFs of papers. Run after 002 (safe to re-run).
--
-- Stages, set by the chapter lead with scripts/push_draft.py --stage:
--   reading -> claim_review -> section_review -> final

-- 1. OSCOLA forms for footnotes (filled by scripts/seed.py) -----------------------

alter table papers add column if not exists oscola text;
alter table papers add column if not exists oscola_short text;

-- 2. Chapter state and section metadata (service key only) ------------------------

create table if not exists chapter_state (
  id         boolean primary key default true check (id),
  stage      text not null default 'reading' check (stage in ('reading', 'claim_review', 'section_review', 'final')),
  title      text,
  abstract   text,
  updated_at timestamptz not null default now()
);
insert into chapter_state (id) values (true) on conflict (id) do nothing;

create table if not exists chapter_sections (
  section         int primary key check (section between 1 and 9),
  title           text not null,
  word_budget     int not null,
  citation_budget int not null default 0
);

create or replace function current_stage() returns text
  language sql stable security definer set search_path = public
  as $$ select stage from chapter_state where id $$;

-- 3. Section text, one row per version ---------------------------------------------

create table if not exists section_versions (
  id          bigint generated always as identity primary key,
  section     int not null check (section between 1 and 9),
  version     int not null,
  body        text not null check (char_length(body) <= 60000),
  created_by  uuid references readers (user_id) on delete set null,  -- null = the AI
  change_note text check (char_length(change_note) <= 500),
  created_at  timestamptz not null default now(),
  unique (section, version)
);

-- Versions go up one at a time; saving on top of an outdated version fails
create or replace function next_section_version() returns trigger language plpgsql as $$
declare
  latest int;
begin
  perform pg_advisory_xact_lock(hashtext('section-' || new.section));
  select coalesce(max(version), 0) into latest from section_versions where section = new.section;
  if new.version is null then
    new.version := latest + 1;
  elsif new.version <> latest + 1 then
    raise exception 'Someone else saved a newer version of this section' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists section_versions_number on section_versions;
create trigger section_versions_number before insert on section_versions
  for each row execute function next_section_version();

create or replace function is_latest_version(version_id bigint) returns boolean
  language sql stable security definer set search_path = public
  as $$
    select exists (
      select 1 from section_versions v
      where v.id = version_id
        and v.version = (select max(version) from section_versions w where w.section = v.section))
  $$;

-- 4. Claims linked to citations, and the readers' verdicts -------------------------

create table if not exists draft_claims (
  id                 bigint generated always as identity primary key,
  paper_id           text not null references papers (id) on delete cascade,
  section            int check (section between 1 and 9),
  section_version_id bigint references section_versions (id) on delete set null,
  anchor             text check (char_length(anchor) <= 4000),   -- the sentence(s) in the text
  claim              text not null check (char_length(claim) between 3 and 2000),
  pinpoint           text check (char_length(pinpoint) <= 100),
  basis              text not null check (basis in ('full_text', 'abstract', 'reader')),
  added_by           uuid references readers (user_id) on delete cascade,  -- null = the AI
  status             text not null default 'open' check (status in ('open', 'addressed', 'dropped')),
  created_at         timestamptz not null default now()
);

create table if not exists claim_reviews (
  claim_id          bigint not null references draft_claims (id) on delete cascade,
  user_id           uuid not null references readers (user_id) on delete cascade,
  verdict           text not null check (verdict in ('supported', 'needs_change', 'not_supported')),
  comment           text check (char_length(comment) <= 4000),
  suggested_wording text check (char_length(suggested_wording) <= 4000),
  page              text check (char_length(page) <= 100),
  updated_at        timestamptz not null default now(),
  primary key (claim_id, user_id)
);

create table if not exists paper_reviews (
  paper_id   text not null references papers (id) on delete cascade,
  user_id    uuid not null references readers (user_id) on delete cascade,
  decision   text not null check (decision in ('approve', 'approve_with_additions', 'reject')),
  extra_info text check (char_length(extra_info) <= 6000),
  reason     text check (char_length(reason) <= 4000),
  updated_at timestamptz not null default now(),
  primary key (paper_id, user_id)
);

drop trigger if exists claim_reviews_touch on claim_reviews;
create trigger claim_reviews_touch before update on claim_reviews for each row execute function touch_updated_at();
drop trigger if exists paper_reviews_touch on paper_reviews;
create trigger paper_reviews_touch before update on paper_reviews for each row execute function touch_updated_at();

-- 5. Section approvals ---------------------------------------------------------------

create table if not exists section_approvals (
  section_version_id bigint not null references section_versions (id) on delete cascade,
  user_id            uuid not null references readers (user_id) on delete cascade,
  created_at         timestamptz not null default now(),
  primary key (section_version_id, user_id)
);

-- 6. PDFs of papers shared by readers ------------------------------------------------

create table if not exists paper_files (
  id           bigint generated always as identity primary key,
  paper_id     text not null references papers (id) on delete cascade,
  storage_path text not null unique,
  file_name    text not null check (char_length(file_name) <= 300),
  size_bytes   bigint,
  uploaded_by  uuid not null default auth.uid() references readers (user_id) on delete cascade,
  created_at   timestamptz not null default now(),
  check (storage_path like paper_id || '/' || uploaded_by || '/%')
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('papers', 'papers', false, 52428800, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists papers_files_read on storage.objects;
create policy papers_files_read on storage.objects for select to authenticated
  using (bucket_id = 'papers');
drop policy if exists papers_files_upload on storage.objects;
create policy papers_files_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'papers' and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists papers_files_delete on storage.objects;
create policy papers_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'papers' and (storage.foldername(name))[2] = auth.uid()::text);

-- 7. Row-level security -------------------------------------------------------------

alter table chapter_state     enable row level security;
alter table chapter_sections  enable row level security;
alter table section_versions  enable row level security;
alter table draft_claims      enable row level security;
alter table claim_reviews     enable row level security;
alter table paper_reviews     enable row level security;
alter table section_approvals enable row level security;
alter table paper_files       enable row level security;

revoke all on chapter_state, chapter_sections, section_versions, draft_claims, claim_reviews,
  paper_reviews, section_approvals, paper_files from anon;

do $$
declare t text;
begin
  foreach t in array array['chapter_state', 'chapter_sections', 'section_versions', 'draft_claims',
                           'claim_reviews', 'paper_reviews', 'section_approvals', 'paper_files'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- Readers save new versions of sections 2-8 while sections are under review
drop policy if exists section_versions_insert on section_versions;
create policy section_versions_insert on section_versions for insert to authenticated
  with check (created_by = auth.uid() and section between 2 and 8 and current_stage() = 'section_review');

-- Readers add their own claims while claims are under review, and can change or remove them
drop policy if exists draft_claims_insert on draft_claims;
create policy draft_claims_insert on draft_claims for insert to authenticated
  with check (added_by = auth.uid() and basis = 'reader' and status = 'open'
              and section_version_id is null and current_stage() = 'claim_review');
drop policy if exists draft_claims_update on draft_claims;
create policy draft_claims_update on draft_claims for update to authenticated
  using (added_by = auth.uid() and current_stage() = 'claim_review')
  with check (added_by = auth.uid() and basis = 'reader' and status = 'open' and section_version_id is null);
drop policy if exists draft_claims_delete on draft_claims;
create policy draft_claims_delete on draft_claims for delete to authenticated
  using (added_by = auth.uid() and current_stage() = 'claim_review');

-- Verdicts on claims and decisions on papers: your own, while claims are under review
do $$
declare t text;
begin
  foreach t in array array['claim_reviews', 'paper_reviews'] loop
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('create policy %I on %I for insert to authenticated
      with check (user_id = auth.uid() and current_stage() = ''claim_review'')', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('create policy %I on %I for update to authenticated
      using (user_id = auth.uid() and current_stage() = ''claim_review'')
      with check (user_id = auth.uid())', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format('create policy %I on %I for delete to authenticated
      using (user_id = auth.uid() and current_stage() = ''claim_review'')', t || '_delete', t);
  end loop;
end $$;

-- Approvals: your own, of the latest version, while sections are under review
drop policy if exists section_approvals_insert on section_approvals;
create policy section_approvals_insert on section_approvals for insert to authenticated
  with check (user_id = auth.uid() and current_stage() = 'section_review' and is_latest_version(section_version_id));
drop policy if exists section_approvals_delete on section_approvals;
create policy section_approvals_delete on section_approvals for delete to authenticated
  using (user_id = auth.uid() and current_stage() = 'section_review');

-- Shared PDFs: your own uploads
drop policy if exists paper_files_insert on paper_files;
create policy paper_files_insert on paper_files for insert to authenticated
  with check (uploaded_by = auth.uid());
drop policy if exists paper_files_delete on paper_files;
create policy paper_files_delete on paper_files for delete to authenticated
  using (uploaded_by = auth.uid());

-- 8. Live updates -------------------------------------------------------------------

do $$
declare t text;
begin
  -- Every table the page subscribes to must be listed, or its whole live-update channel fails
  foreach t in array array['chapter_state', 'chapter_sections', 'section_versions', 'draft_claims', 'claim_reviews',
                           'paper_reviews', 'section_approvals', 'paper_files'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
