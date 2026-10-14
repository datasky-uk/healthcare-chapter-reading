# Chapter reading tracker

A shared web page where the chapter's co-readers claim papers, write structured notes, add papers the list is missing and share documents. They also check the AI draft's claims, and edit and approve the chapter section by section. Each essential read gets two readers, and every other paper gets one. The page runs on GitHub Pages and stores its data in Supabase (free tier). Collaborators sign in with a one-time link emailed to them, so they need no passwords and no accounts elsewhere.

## Set up (once)

1. **Supabase.**
   - Create a free project at supabase.com.
   - In *SQL Editor*, paste and run `supabase/schema.sql`, then `supabase/002_added_papers_and_materials.sql`, then `supabase/003_drafting.sql`. All three are safe to re-run.
   - In *Authentication → Sign In / Providers*, turn **off** "Allow new users to sign up", so only invited people can sign in.
   - In *Authentication → URL Configuration*, set the Site URL to the tracker address from step 3 and add it to the redirect URLs.
   - **Set up email delivery.** Supabase's built-in sender only delivers to your own project team's addresses, and only a few emails an hour, so it can't reach external collaborators. In *Authentication → Emails → SMTP Settings*, connect a sending service. Your institution's SMTP server works, or a free tier from Resend or Brevo. Then raise the email limit in *Authentication → Rate Limits*.
   - Leave the *Email* provider itself **enabled**. Only the sign-up switch above should be off; turning off the provider blocks every sign-in link.
2. **Local settings.**
   - Run `cp .env.example .env`.
   - Fill in the project URL and keys from *Project Settings → API*, plus `SITE_URL`.
   - Never commit `.env`: it holds the service key.
3. **Load the papers and publish the page.**
   ```
   python3 scripts/seed.py            # loads the 204 papers
   python3 scripts/configure_web.py   # writes web/config.js (URL + public anon key only)
   git push                           # GitHub Actions publishes web/ to Pages
   ```
   In the GitHub repo, set *Settings → Pages → Source* to "GitHub Actions".
4. **Add the chapter documents** to the *Materials* page (see below).
5. **Invite people.**
   ```
   python3 scripts/invite.py alice@uni.edu bob@inst.org
   ```

## Day to day

- `python3 scripts/export_notes.py` writes every note to `../notes_export.md`, grouped by chapter section. Readers can also download notes as Markdown or CSV from the page.
- **Adding a paper:** add it to `../chapter_outline_and_literature.md`, then run `build_references.py`, `oa_lookup.py` and `seed.py`.
- **OSCOLA footnotes:** `python3 scripts/oscola.py --fetch` writes `../oscola_references.md`. The chapter uses OSCOLA footnotes with no bibliography, so the file gives the first-citation footnote for every reference, with the planned citations first and each one's word count. The publisher's 5,000–6,000-word limit includes references.
  - The citation plan is the `PLANNED` list in the script.
  - References without a Crossref record have hand-written forms in `MANUAL`.
  - Existing papers keep their ids, matched by DOI or citation, so claims and notes stay attached.
  - `seed.py` removes papers dropped from the bibliography, but only if nobody has claimed or noted them. It warns about the rest.
- **Papers added by readers:** any reader can add a paper from *Add a paper*. Pasting a DOI fills in the details from OpenAlex or Crossref. The paper then appears in everyone's list, marked "added".
  - The person who added a paper can edit it, and can remove it until someone else claims it or writes a note on it.
  - Ranks stay yours: readers can't give a paper a rank.
  - `export_notes.py` lists these papers separately, so you can move the good ones into `chapter_outline_and_literature.md`.
  - When a paper a reader added appears in the bibliography, `seed.py` takes over that entry, keeping its claims and notes. `seed.py` never deletes papers readers added.
- **Materials:** the *Materials* page has your chapter documents at the top, then anything readers share (files up to 50 MB, or links).
  - Files sit in a private Supabase Storage bucket. Only signed-in readers can open them, through links that expire after 10 minutes.
  - Readers can remove only what they shared themselves.
  - To add or update your own documents:
    ```
    python3 scripts/add_material.py ../materials/AI_in_Healthcare_chapter_plan_and_literature.pdf \
        --title "Chapter plan: abstract, outline and literature" --description "Start here." --order 1
    python3 scripts/add_material.py --link https://docs.google.com/... --title "Shared draft" --order 5
    python3 scripts/add_material.py --list
    python3 scripts/add_material.py --remove ID
    ```
    Uploading a file with the same name again replaces it.

## Writing the chapter

The AI steps are run on request in Claude Code. The readers' steps happen on the page. The tracker's *stage* decides which actions are open.

| Stage | Who | What happens |
|---|---|---|
| `reading` | readers | Claim papers and take notes. |
| (AI step 1–2) | AI | Writes §2–§8 in `../chapter/draft/s2.md`…`s8.md`, with citation keys like `[@s3-han-r-2024, e370]`. Writes `claims.json`, one to three claims per citation, each anchored to its sentence and marked as drafted from the full text or the abstract. Then `push_draft.py --stage claim_review`. |
| `claim_review` | readers | Open their papers. Under *In the draft*, mark each claim supported, needs change or not supported (with page, suggested wording and comment). Add claims, then approve, approve with additions or reject the paper. |
| (AI step 4) | AI | `export_feedback.py` gathers the feedback and the conflicts for the chapter lead. The AI rebuilds the sections, marks claims `addressed` or `dropped` in `claims.json`, then runs `push_draft.py --note "..." --stage section_review`. |
| `section_review` | readers | On the *Chapter* tab, edit the text and approve. A section needs two approvals of its latest version, and every edit makes a new version, so approvals start again. History shows the changes word by word. |
| (AI step 6) | AI | `pull_sections.py`, then the AI writes §1 and §9, pushes them, and runs `build_docx.py --upload`. This produces Word footnotes in OSCOLA, checks the 6,000-word limit and puts the file on the Materials page. Then `push_draft.py --stage final`. |

- **Footnotes are generated, never typed.** They are numbered across the chapter: the full OSCOLA form first, then the short form with "(n X)", then "ibid". The forms come from `data/oscola.json`, written by `oscola.py`.
- **Word counts** include the abstract, headings and footnotes, as the publisher counts them. The page and `build_docx.py` use the same rule.
- **Checking progress:** `push_draft.py --status` shows the word counts and approvals.
- **Publisher's Word template:** if there is one, use `build_docx.py --reference template.docx`.

## Full texts

- **Finding free copies:** `oa_lookup.py` looks for a legal free copy of each paper using OpenAlex, Europe PMC and preprint servers.
- **Downloading:** `download_oa.py` saves the open-access PDFs to `../papers/` for personal use, with an `INDEX.md`. That folder is never published.
- **Paywalled papers:** readers can upload the PDF on the paper itself. Every signed-in reader can then open it. Licences usually limit sharing to the subscribing institution, so responsibility for each upload rests with the reader who uploads it.
  - Files sit in the private `papers` bucket and open through links that expire after 10 minutes.
  - `pull_paper_files.py` copies them to `../papers/` so the drafting can use the full text.

## Data and privacy

- The tracker stores readers' names, institutions, email addresses (held by Supabase Auth), claims, notes, the papers they add, the files and PDFs they share, their checks of the draft's claims, their decisions on papers, their edits and their approvals.
- Only signed-in, invited readers can see any of it. Each reader can change only their own claims and notes.
- The bibliography papers can be changed only with the service key. Readers can change only the papers they added and the materials they shared.
- **DOI lookups:** when a reader looks up a DOI, their browser sends that DOI to OpenAlex and Crossref, which are public bibliographic databases. Nothing else is sent.
