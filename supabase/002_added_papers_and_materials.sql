-- Readers can add papers, and the team shares chapter materials (files and links).
-- Run in the Supabase SQL editor after schema.sql (safe to re-run).

-- 1. Papers added by readers ------------------------------------------------

alter table papers add column if not exists added_by uuid references readers (user_id) on delete set null;
alter table papers add column if not exists created_at timestamptz not null default now();
alter table papers alter column id set default 'r-' || substr(md5(gen_random_uuid()::text), 1, 10);

-- Links must be web addresses (a "javascript:" link would run in other readers' browsers)
alter table papers drop constraint if exists papers_links_http;
alter table papers add constraint papers_links_http check (
  (url is null or url ~* '^https?://') and (oa_url is null or oa_url ~* '^https?://')
  and (pdf_url is null or pdf_url ~* '^https?://'));
alter table papers drop constraint if exists papers_reader_text;
alter table papers add constraint papers_reader_text check (
  char_length(citation) <= 2000 and coalesce(char_length(title), 0) <= 500
  and coalesce(char_length(short_cite), 0) <= 200 and coalesce(char_length(why_read), 0) <= 2000);

-- One row per DOI, so the same paper isn't added twice
create unique index if not exists papers_doi_unique on papers (lower(doi)) where doi is not null;

drop trigger if exists papers_touch on papers;
create trigger papers_touch before update on papers for each row execute function touch_updated_at();

-- A reader adds papers as themselves, never with a rank (ranks are the chapter lead's)
drop policy if exists papers_insert on papers;
create policy papers_insert on papers for insert to authenticated
  with check (added_by = auth.uid() and rank is null);
drop policy if exists papers_update on papers;
create policy papers_update on papers for update to authenticated
  using (added_by = auth.uid() and rank is null)
  with check (added_by = auth.uid() and rank is null);
-- ...and can remove one only while nobody else has claimed it or written a note on it
drop policy if exists papers_delete on papers;
create policy papers_delete on papers for delete to authenticated
  using (added_by = auth.uid() and rank is null
         and not exists (select 1 from claims c where c.paper_id = papers.id and c.user_id <> auth.uid())
         and not exists (select 1 from notes n where n.paper_id = papers.id and n.user_id <> auth.uid()));

-- 2. Chapter materials -------------------------------------------------------

create table if not exists materials (
  id           bigint generated always as identity primary key,
  title        text not null check (char_length(title) between 1 and 200),
  description  text check (char_length(description) <= 1000),
  storage_path text,  -- object in the private "materials" bucket
  url          text check (url ~* '^https?://'),
  file_name    text,
  size_bytes   bigint,
  sort_order   int,   -- chapter lead's documents first, in this order
  added_by     uuid default auth.uid() references readers (user_id) on delete set null,
  created_at   timestamptz not null default now(),
  check ((storage_path is null) <> (url is null))
);

alter table materials enable row level security;
revoke all on materials from anon;

drop policy if exists materials_read on materials;
create policy materials_read on materials for select to authenticated using (true);
drop policy if exists materials_insert on materials;
create policy materials_insert on materials for insert to authenticated
  with check (added_by = auth.uid() and sort_order is null
              and (storage_path is null or storage_path like 'readers/' || auth.uid() || '/%'));
drop policy if exists materials_update on materials;
create policy materials_update on materials for update to authenticated
  using (added_by = auth.uid())
  with check (added_by = auth.uid() and sort_order is null
              and (storage_path is null or storage_path like 'readers/' || auth.uid() || '/%'));
drop policy if exists materials_delete on materials;
create policy materials_delete on materials for delete to authenticated using (added_by = auth.uid());

-- Private file bucket: signed-in readers can open everything; each reader uploads
-- and deletes only under readers/<their id>/. The chapter lead's files go under
-- chapter/ using the service key (scripts/add_material.py).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('materials', 'materials', false, 52428800, array[
  'application/pdf', 'text/markdown', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists materials_files_read on storage.objects;
create policy materials_files_read on storage.objects for select to authenticated
  using (bucket_id = 'materials');
drop policy if exists materials_files_upload on storage.objects;
create policy materials_files_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'materials' and (storage.foldername(name))[1] = 'readers'
              and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists materials_files_delete on storage.objects;
create policy materials_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'materials' and (storage.foldername(name))[1] = 'readers'
         and (storage.foldername(name))[2] = auth.uid()::text);

-- 3. Live updates -------------------------------------------------------------

do $$ begin
  alter publication supabase_realtime add table papers;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table materials;
exception when duplicate_object then null; end $$;
