# Chapter reading tracker

A shared web page where the chapter's co-readers claim papers and write structured notes. Each essential read gets two readers, and every other paper gets one. The page runs on GitHub Pages and stores its data in Supabase (free tier). Collaborators sign in with a one-time link emailed to them, so they need no passwords and no accounts elsewhere.

## Set up (once)

1. **Supabase.**
   - Create a free project at supabase.com.
   - In *SQL Editor*, paste and run `supabase/schema.sql`.
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
4. **Invite people.**
   ```
   python3 scripts/invite.py alice@uni.edu bob@inst.org
   ```

## Day to day

- `python3 scripts/export_notes.py` writes every note to `../notes_export.md`, grouped by chapter section. Readers can also download notes as Markdown or CSV from the page.
- **Adding a paper:** add it to `../chapter_outline_and_literature.md`, then run `build_references.py`, `oa_lookup.py` and `seed.py`.
  - Existing papers keep their ids, matched by DOI or citation, so claims and notes stay attached.
  - `seed.py` removes papers dropped from the bibliography, but only if nobody has claimed or noted them. It warns about the rest.
- **Reader suggestions:** the "Suggest" tab collects papers readers propose. Mark each one added or declined in the Supabase table editor.

## Full texts

- **Finding free copies:** `oa_lookup.py` looks for a legal free copy of each paper using OpenAlex, Europe PMC and preprint servers.
- **Downloading:** `download_oa.py` saves the open-access PDFs to `../papers/` for personal use, with an `INDEX.md`. That folder is never published.
- **Paywalled papers:** these only link to the publisher. Readers use their own library access, and nobody shares those PDFs in the tracker.

## Data and privacy

- The tracker stores readers' names, institutions, email addresses (held by Supabase Auth), claims and notes.
- Only signed-in, invited readers can see any of it. Each reader can change only their own claims and notes.
- The paper list itself can be changed only with the service key.
