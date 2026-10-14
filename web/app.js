/* Chapter reading tracker: shared claims and structured notes on the chapter's literature. */
(function () {
  'use strict';

  const cfg = window.TRACKER_CONFIG;
  const app = document.getElementById('app');
  const dialog = document.getElementById('paper-dialog');

  const SECTIONS = {
    1: 'Introduction and approach', 2: 'Technological foundations', 3: 'Diagnostics',
    4: 'Decision support, workflow and operations', 5: 'Biomedical research and drug discovery',
    6: 'AI and the expanding literature', 7: 'Emerging models of evidence synthesis',
    8: 'Bias, safety and governance', 9: 'Conclusions and future directions',
  };
  const TAGS = {
    essential: { label: 'Essential read', need: 2 },
    should: { label: 'Should read', need: 1 },
    mildly: { label: 'Mildly interesting', need: 1 },
    reference: { label: 'Reference', need: 1 },
  };
  const STATUS_LABEL = { claimed: 'Claimed', reading: 'Reading', done: 'Done' };
  const FLAG_TEXT = {
    preprint: ['Preprint', 'Not peer-reviewed: cite it as a preprint.'],
    partly: ['Partly verified', 'Confirmed only through secondary sources, or metadata only.'],
    unverified: ['Unverified', 'Could not be confirmed: do not cite until checked.'],
  };
  const NOTE_FIELDS = [
    ['key_finding', 'Key finding'], ['design_sample', 'Design and sample'], ['key_numbers', 'Key numbers'],
    ['limitations', 'Limitations'], ['chapter_use', 'Use in the chapter'], ['quotable', 'Quotable'],
  ];

  const state = {
    sb: null, session: null, me: null,
    papers: [], claims: [], notes: [], readers: [], materials: [],
    chapter_state: [], chapter_sections: [], section_versions: [], draft_claims: [], claim_reviews: [],
    paper_reviews: [], section_approvals: [], paper_files: [], editing: null,
    filters: { q: '', section: '', tag: 'ranked', status: '', access: '' },
    openPaperId: null, editPaperId: null, channel: null,
  };

  /* ---------- small helpers ---------- */

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value;
      else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'required') el[key] = Boolean(value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function currentView() { return (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0]; }

  function mount(...nodes) {
    app.dataset.view = currentView(); // lets live updates know which view is on screen
    app.replaceChildren(...nodes);
  }

  let toastTimer;
  function toast(message, isError) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 6000 : 3000);
  }

  function uid() { return state.session && state.session.user.id; }
  function readerName(id) {
    const r = state.readers.find((x) => x.user_id === id);
    return (r && r.display_name) || 'Someone';
  }
  function claimsFor(pid) { return state.claims.filter((c) => c.paper_id === pid); }
  function notesFor(pid) { return state.notes.filter((n) => n.paper_id === pid); }
  function myClaim(pid) { return state.claims.find((c) => c.paper_id === pid && c.user_id === uid()); }
  function myNote(pid) { return state.notes.find((n) => n.paper_id === pid && n.user_id === uid()); }
  function need(p) { return TAGS[p.tag].need; }
  function paperById(pid) { return state.papers.find((p) => p.id === pid); }

  function paperState(p) {
    const claims = claimsFor(p.id);
    if (claims.length < need(p)) return claims.length ? 'partial' : 'open';
    return claims.every((c) => c.status === 'done') ? 'done' : 'progress';
  }

  function readsDone(p) {
    return Math.min(claimsFor(p.id).filter((c) => c.status === 'done').length, need(p));
  }
  function readsClaimed(p) { return Math.min(claimsFor(p.id).length, need(p)); }

  function shortCite(p) { return p.short_cite || p.id; }
  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
  function friendlyError(error) {
    const msg = (error && (error.message || error.error_description)) || String(error);
    if (/all its readers/i.test(msg)) return 'Someone just claimed the last reader slot for this paper.';
    if (/papers_doi_unique/i.test(msg)) return 'A paper with this DOI is already in the list.';
    if (/mime type/i.test(msg)) return 'That file type is not accepted here.';
    if (/maximum allowed size|too large/i.test(msg)) return 'Files can be up to 50 MB.';
    if (/duplicate key/i.test(msg)) return 'You have already claimed this paper.';
    if (/JWT|session/i.test(msg)) return 'Your session expired. Please sign in again.';
    if (/after \d+ seconds/i.test(msg)) return 'A link was sent to this address moments ago. Please wait a minute and try again.';
    if (/rate limit/i.test(msg)) return 'Too many sign-in emails have been sent recently. Please try again later.';
    return msg;
  }

  /* ---------- data ---------- */

  const TABLES = ['papers', 'claims', 'notes', 'readers', 'materials', 'chapter_state', 'chapter_sections', 'section_versions',
    'draft_claims', 'claim_reviews', 'paper_reviews', 'section_approvals', 'paper_files'];

  async function loadTable(table) {
    const { data, error } = await state.sb.from(table).select('*');
    if (error) throw error;
    state[table] = data;
    if (table === 'papers') {
      state.papers.sort((a, b) => (a.rank || 999) - (b.rank || 999) || a.section - b.section
        || shortCite(a).localeCompare(shortCite(b)));
    }
  }

  async function loadAll() {
    await Promise.all(TABLES.map(loadTable));
    state.me = state.readers.find((r) => r.user_id === uid()) || null;
  }

  let refreshTimer;
  function subscribe() {
    if (state.channel) return;
    const pending = new Set();
    const onChange = (payload) => {
      pending.add(payload.table);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        const tables = [...pending];
        pending.clear();
        try {
          await Promise.all(tables.map(loadTable));
          rerender();
        } catch (err) { /* the next change or reload will catch up */ }
      }, 400);
    };
    state.channel = state.sb.channel('tracker');
    for (const table of TABLES) {
      state.channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
    }
    state.channel.subscribe();
  }

  function rerender() {
    if (dialog.open && state.openPaperId && !paperById(state.openPaperId)) dialog.close();
    route(true);
    if (dialog.open && state.openPaperId) refreshDialogLive();
  }

  async function claim(pid, status) {
    const { error } = await state.sb.from('claims').insert({ paper_id: pid, user_id: uid(), status: status || 'claimed' });
    if (error) { toast(friendlyError(error), true); return false; }
    await loadTable('claims');
    toast('Claimed. It is on your reading list.');
    rerender();
    return true;
  }

  async function setStatus(pid, status) {
    const { error } = await state.sb.from('claims').update({ status }).eq('paper_id', pid).eq('user_id', uid());
    if (error) { toast(friendlyError(error), true); return; }
    await loadTable('claims');
    rerender();
  }

  async function unclaim(pid) {
    if (!confirm('Give up this paper? Your note, if any, is kept.')) return;
    const { error } = await state.sb.from('claims').delete().eq('paper_id', pid).eq('user_id', uid());
    if (error) { toast(friendlyError(error), true); return; }
    await loadTable('claims');
    toast('Released for someone else to claim.');
    rerender();
  }

  /* ---------- shared pieces ---------- */

  function tagPill(p) {
    return h('span', { class: `pill pill-${p.tag}` }, TAGS[p.tag].label);
  }

  function accessBadge(p) {
    if (p.oa_status === 'web') return h('span', { class: 'badge badge-oa' }, 'Official web page');
    if (p.is_oa) return h('span', { class: 'badge badge-oa' }, p.pdf_url ? 'Free full text · PDF' : 'Free full text');
    return h('span', { class: 'badge badge-closed' }, 'Paywalled');
  }

  function flagBadges(p) {
    const out = [];
    if (FLAG_TEXT[p.verify_flag]) out.push(h('span', { class: 'badge badge-warn' }, FLAG_TEXT[p.verify_flag][0]));
    if (p.check_notes && p.check_notes.length) {
      const verified = notesFor(p.id).some((n) => n.numbers_verified);
      out.push(h('span', { class: 'badge ' + (verified ? 'badge-oa' : 'badge-warn') },
        verified ? 'Numbers checked' : 'Check before citing'));
    }
    return out;
  }

  function readerChips(p) {
    const claims = claimsFor(p.id);
    const chips = claims.map((c) => h('span', { class: 'reader-chip' + (c.user_id === uid() ? ' me' : '') },
      `${c.user_id === uid() ? 'You' : readerName(c.user_id)} · ${STATUS_LABEL[c.status]}`));
    const free = need(p) - claims.length;
    if (free > 0) chips.push(h('span', { class: 'slots' }, free === need(p) ? (need(p) === 2 ? 'Needs 2 readers' : 'Needs a reader') : `Needs ${free} more`));
    return chips;
  }

  function claimButton(p) {
    const mine = myClaim(p.id);
    if (mine) return h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => openPaper(p.id) }, 'Open');
    if (claimsFor(p.id).length >= need(p)) return h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => openPaper(p.id) }, 'View');
    return h('button', { class: 'btn btn-small', type: 'button', onclick: (e) => { e.target.disabled = true; claim(p.id); } }, 'Claim');
  }

  function paperRow(p) {
    return h('article', { class: 'paper-row' },
      h('div', { class: 'paper-rank' }, p.rank ? `#${p.rank}` : `§${p.section}`,
        h('span', { class: 'small' }, p.rank ? `§${p.section}` : p.added_by ? 'added' : 'ref')),
      h('div', {},
        h('button', { class: 'paper-title', type: 'button', onclick: () => openPaper(p.id) }, p.title || shortCite(p)),
        h('p', { class: 'paper-meta' }, `${shortCite(p)} · ${SECTIONS[p.section]}${p.added_by ? ` · added by ${p.added_by === uid() ? 'you' : readerName(p.added_by)}` : ''}`),
        p.why_read ? h('p', { class: 'paper-meta' }, p.why_read) : null,
        h('div', { class: 'paper-badges' }, tagPill(p), accessBadge(p),
          filesOf(p.id).length ? h('span', { class: 'badge badge-oa' }, 'PDF shared') : null, flagBadges(p),
          stage() === 'claim_review' && myClaim(p.id) && needsMyCheck(p.id) ? h('span', { class: 'badge badge-warn' }, 'Claims to check') : null)),
      h('div', { class: 'paper-side' }, h('div', { class: 'readers' }, readerChips(p)), claimButton(p)));
  }

  function exportButtons() {
    return h('div', { class: 'row' },
      h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: exportMarkdown }, 'Download all notes (Markdown)'),
      h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: exportCsv }, 'Download all notes (CSV)'));
  }

  /* ---------- views ---------- */

  function renderSetup() {
    mount(h('div', { class: 'card card-narrow stack' },
      h('h1', {}, 'Not configured yet'),
      h('p', {}, 'This page has no Supabase settings. Run scripts/configure_web.py, then reload.')));
  }

  function renderSignIn() {
    let sent = false;
    const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true, placeholder: 'you@university.edu' });
    const message = h('p', { class: 'small muted', role: 'status' });
    const button = h('button', { class: 'btn', type: 'submit' }, 'Email me a sign-in link');
    const form = h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        if (sent) return;
        button.disabled = true;
        message.textContent = 'Sending…';
        const { error } = await state.sb.auth.signInWithOtp({
          email: email.value.trim(),
          options: { shouldCreateUser: false, emailRedirectTo: location.href.split('#')[0] },
        });
        if (error) {
          button.disabled = false;
          message.textContent = /signup|not allowed|not found/i.test(error.message)
            ? `That address hasn't been invited yet. Ask ${cfg.contact || 'the chapter lead'} to add you.`
            : friendlyError(error);
          return;
        }
        sent = true;
        message.textContent = `Check your inbox at ${email.value.trim()} for a sign-in link. You can close this tab.`;
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email address'), email),
    button, message);
    mount(h('div', { class: 'card card-narrow stack' },
      h('h1', {}, 'Chapter reading tracker'),
      h('p', {}, 'Shared reading for the chapter "Artificial Intelligence in Healthcare". Sign in with the email address you were invited with; we\'ll send you a one-time link, no password needed.'),
      form));
  }

  function renderProfile(isEdit) {
    const name = h('input', { type: 'text', id: 'name', required: true, maxlength: 80, value: state.me ? state.me.display_name : '', autocomplete: 'name' });
    const affiliation = h('input', { type: 'text', id: 'affiliation', maxlength: 160, value: state.me ? (state.me.affiliation || '') : '', autocomplete: 'organization' });
    const form = h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const row = { user_id: uid(), display_name: name.value.trim(), affiliation: affiliation.value.trim() || null };
        const { error } = await state.sb.from('readers').upsert(row);
        if (error) { toast(friendlyError(error), true); return; }
        await loadTable('readers');
        state.me = state.readers.find((r) => r.user_id === uid());
        showChrome();
        subscribe();
        location.hash = isEdit ? '#/mine' : '#/overview';
        route();
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'name' }, 'Your name'), name,
      h('span', { class: 'hint' }, 'Shown to the other readers next to your claims and notes.')),
    h('div', { class: 'field' }, h('label', { for: 'affiliation' }, 'Institution (optional)'), affiliation),
    h('button', { class: 'btn', type: 'submit' }, isEdit ? 'Save' : 'Continue'));
    mount(h('div', { class: 'card card-narrow stack' },
      h('h1', {}, isEdit ? 'Your profile' : 'Welcome'),
      isEdit ? null : h('p', {}, 'One step before you start: tell the team who you are.'),
      form));
  }

  function progressRow(label, done, claimed, total) {
    const pct = (n) => (total ? (100 * n) / total : 0);
    return h('div', { class: 'progress-row' },
      h('span', {}, label),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${label}: ${done} of ${total} read, ${claimed - done} more claimed` },
        h('div', { class: 'bar-done', style: `width:${pct(done)}%` }),
        h('div', { class: 'bar-claimed', style: `width:${pct(claimed - done)}%` })),
      h('span', { class: 'small muted' }, `${done} read · ${claimed - done} claimed · ${total - claimed} open`));
  }

  function renderOverview() {
    const ranked = state.papers.filter((p) => p.rank);
    const tagRows = ['essential', 'should', 'mildly'].map((tag) => {
      const group = ranked.filter((p) => p.tag === tag);
      const total = group.reduce((s, p) => s + need(p), 0);
      const done = group.reduce((s, p) => s + readsDone(p), 0);
      const claimed = group.reduce((s, p) => s + readsClaimed(p), 0);
      const label = `${TAGS[tag].label} (${group.length}${tag === 'essential' ? ' × 2 readers' : ''})`;
      return { tag, total, done, claimed, row: progressRow(label, done, claimed, total) };
    });
    const fullyRead = ranked.filter((p) => paperState(p) === 'done').length;
    const mine = state.claims.filter((c) => c.user_id === uid());

    const needsReaders = ranked.filter((p) => claimsFor(p.id).length < need(p)).slice(0, 12);
    const added = state.papers.filter((p) => p.added_by).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const toCheck = state.papers.filter((p) => p.check_notes && p.check_notes.length
      && !notesFor(p.id).some((n) => n.numbers_verified));

    const sectionRows = Object.keys(SECTIONS).map(Number).filter((s) => state.papers.some((p) => p.section === s)).map((s) => {
      const all = state.papers.filter((p) => p.section === s);
      const rk = all.filter((p) => p.rank);
      return h('tr', {},
        h('td', {}, `§${s} ${SECTIONS[s]}`),
        h('td', { class: 'num' }, `${rk.filter((p) => paperState(p) === 'done').length} / ${rk.length}`),
        h('td', { class: 'num' }, `${all.filter((p) => notesFor(p.id).length).length} / ${all.length}`));
    });

    mount(h('div', { class: 'stack-lg' },
      h('div', { class: 'stack' },
        h('h1', {}, 'Reading progress'),
        h('p', { class: 'muted' }, `${plural(state.readers.length, 'reader')} · ${fullyRead} of ${ranked.length} ranked papers fully read · ${plural(state.notes.length, 'note')} written`)),
      h('div', { class: 'tiles' },
        tagRows.map((t) => h('div', { class: 'tile' },
          h('div', { class: 'tile-value' }, `${t.done}/${t.total}`),
          h('div', { class: 'tile-label' }, `${TAGS[t.tag].label}: reads done`))),
        h('div', { class: 'tile' },
          h('div', { class: 'tile-value' }, String(mine.length)),
          h('div', { class: 'tile-label' }, `Your claims · ${mine.filter((c) => c.status === 'done').length} done`))),
      state.section_versions.length ? (() => {
        const aiClaims = state.draft_claims.filter((c) => c.basis !== 'reader' && c.status !== 'dropped');
        const checked = aiClaims.filter((c) => reviewsOf(c.id).length).length;
        const approved = [2, 3, 4, 5, 6, 7, 8].filter((sec) => { const v = latestVersion(sec); return v && approvalsOf(v.id).length >= 2; }).length;
        return h('section', { class: 'card stack' },
          h('div', { class: 'section-head' }, h('h2', {}, 'Writing the chapter'), h('a', { href: '#/chapter' }, 'Open the chapter')),
          stageBanner(),
          h('p', {}, `${checked} of ${aiClaims.length} claims checked · ${new Set(state.paper_reviews.map((r) => r.paper_id)).size} papers with a decision · ${approved} of 7 sections approved · ${chapterCounts().total.toLocaleString()} words`));
      })() : null,
      h('section', { class: 'card stack' },
        h('h2', {}, 'Progress by tag'),
        h('div', { class: 'legend' },
          h('span', {}, h('span', { class: 'swatch', style: 'background:var(--accent)' }), 'Read'),
          h('span', {}, h('span', { class: 'swatch', style: 'background:var(--accent-soft);border:1px solid var(--accent)' }), 'Claimed'),
          h('span', {}, h('span', { class: 'swatch', style: 'background:var(--track)' }), 'Open')),
        tagRows.map((t) => t.row)),
      h('section', { class: 'stack' },
        h('div', { class: 'section-head' },
          h('h2', {}, 'Needs readers'),
          h('a', { href: '#/papers', onclick: () => { state.filters.status = 'open'; state.filters.tag = 'ranked'; } }, 'See all')),
        needsReaders.length ? h('div', { class: 'paper-list' }, needsReaders.map(paperRow))
          : h('p', { class: 'empty' }, 'Every ranked paper has its readers.')),
      h('section', { class: 'stack' },
        h('div', { class: 'section-head' },
          h('h2', {}, `Added by readers (${added.length})`),
          h('div', { class: 'row' },
            added.length > 6 ? h('a', { href: '#/papers', onclick: () => { state.filters.tag = 'added'; state.filters.status = ''; } }, 'See all') : null,
            h('a', { class: 'btn btn-small', href: '#/add' }, 'Add a paper'))),
        added.length ? h('div', { class: 'paper-list' }, added.slice(0, 6).map(paperRow))
          : h('p', { class: 'empty' }, 'Found something the list is missing? Add it and it appears here for everyone.')),
      h('section', { class: 'card stack' },
        h('h2', {}, 'By chapter section'),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('tr', {}, h('th', {}, 'Section'), h('th', { class: 'num' }, 'Ranked papers fully read'), h('th', { class: 'num' }, 'Papers with notes')),
          sectionRows))),
      h('section', { class: 'card stack' },
        h('h2', {}, 'Check before citing'),
        h('p', { class: 'muted small' }, 'These papers have figures or details that came from secondary sources. Tick "numbers checked against the full text" in your note once you have confirmed them.'),
        toCheck.length
          ? h('ul', { class: 'list-plain' }, toCheck.map((p) => h('li', {},
            h('button', { class: 'paper-title', type: 'button', onclick: () => openPaper(p.id) }, shortCite(p)),
            h('span', { class: 'muted small' }, ` — ${p.check_notes.join(' ')}`))))
          : h('p', { class: 'muted' }, 'All checked.')),
      h('section', { class: 'stack' }, h('h2', {}, 'Export'), exportButtons())));
  }

  function filterPapers() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    return state.papers.filter((p) => {
      if (f.section && String(p.section) !== f.section) return false;
      if (f.tag === 'ranked' && !p.rank) return false;
      if (f.tag === 'added' && !p.added_by) return false;
      if (f.tag && f.tag !== 'ranked' && f.tag !== 'added' && p.tag !== f.tag) return false;
      if (f.access === 'oa' && !p.is_oa) return false;
      if (f.access === 'closed' && p.is_oa) return false;
      if (f.access === 'shared' && !filesOf(p.id).length) return false;
      if (f.status) {
        const st = paperState(p);
        if (f.status === 'open' && !(st === 'open' || st === 'partial')) return false;
        if (f.status === 'progress' && st !== 'progress') return false;
        if (f.status === 'done' && st !== 'done') return false;
        if (f.status === 'mine' && !myClaim(p.id)) return false;
      }
      if (q && !`${p.title} ${p.citation} ${p.short_cite} ${p.why_read}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function select(id, label, options, key) {
    const el = h('select', {
      id,
      'aria-label': label,
      onchange: (e) => { state.filters[key] = e.target.value; drawList(); },
    }, options.map(([value, text]) => h('option', { value, selected: state.filters[key] === value }, text)));
    return el;
  }

  let listHost, countHost;
  function drawList() {
    const rows = filterPapers();
    countHost.textContent = `${plural(rows.length, 'paper')} shown`;
    listHost.replaceChildren(...(rows.length ? rows.map(paperRow) : [h('p', { class: 'empty' }, 'No papers match these filters.')]));
  }

  function renderPapers() {
    let searchTimer;
    const search = h('input', {
      type: 'search', class: 'search', placeholder: 'Search titles, authors, journals…', 'aria-label': 'Search',
      value: state.filters.q,
      oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.filters.q = e.target.value; drawList(); }, 150); },
    });
    listHost = h('div', { class: 'paper-list' });
    countHost = h('p', { class: 'muted small', role: 'status' });
    mount(h('div', { class: 'stack' },
      h('div', { class: 'section-head' }, h('h1', {}, 'Papers'),
        h('div', { class: 'row' }, countHost, h('a', { class: 'btn btn-small', href: '#/add' }, 'Add a paper'))),
      h('div', { class: 'filters' },
        h('div', { class: 'search' }, search),
        select('f-section', 'Chapter section', [['', 'All sections'], ...Object.entries(SECTIONS).filter(([s]) => state.papers.some((p) => String(p.section) === s)).map(([s, t]) => [s, `§${s} ${t}`])], 'section'),
        select('f-tag', 'Tag', [['ranked', `Ranked (${state.papers.filter((p) => p.rank).length})`], ['', `All (${state.papers.length})`],
          ['added', `Added by readers (${state.papers.filter((p) => p.added_by).length})`],
          ['essential', 'Essential read'], ['should', 'Should read'], ['mildly', 'Mildly interesting'], ['reference', 'Other references']], 'tag'),
        select('f-status', 'Reading status', [['', 'Any status'], ['open', 'Needs readers'], ['progress', 'Being read'], ['done', 'Fully read'], ['mine', 'Claimed by me']], 'status'),
        select('f-access', 'Access', [['', 'Any access'], ['oa', 'Free full text'], ['closed', 'Paywalled'], ['shared', 'PDF shared by a reader']], 'access')),
      listHost));
    drawList();
  }

  function renderMine() {
    const mine = state.claims.filter((c) => c.user_id === uid());
    const groups = ['reading', 'claimed', 'done'].map((status) => {
      const papers = mine.filter((c) => c.status === status).map((c) => paperById(c.paper_id)).filter(Boolean)
        .sort((a, b) => (a.rank || 999) - (b.rank || 999));
      return h('section', { class: 'stack' },
        h('h2', {}, `${STATUS_LABEL[status]} (${papers.length})`),
        papers.length ? h('div', { class: 'paper-list' }, papers.map(paperRow)) : h('p', { class: 'empty' }, 'Nothing here yet.'));
    });
    const notesOnly = state.notes.filter((n) => n.user_id === uid() && !myClaim(n.paper_id)).map((n) => paperById(n.paper_id)).filter(Boolean);
    const toCheck = stage() === 'claim_review' ? mine.map((c) => paperById(c.paper_id)).filter((p) => p && needsMyCheck(p.id)) : [];
    mount(h('div', { class: 'stack-lg' },
      stage() === 'claim_review' ? h('section', { class: 'stack' },
        h('h2', {}, `Claims to check (${toCheck.length})`),
        h('p', { class: 'muted small' }, 'Papers you are reading that the draft cites. Open each one and check its claims under "In the draft".'),
        toCheck.length ? h('div', { class: 'paper-list' }, toCheck.map(paperRow)) : h('p', { class: 'empty' }, 'All done: thank you.')) : null,
      h('div', { class: 'stack' },
        h('h1', {}, 'My reading'),
        h('p', { class: 'muted' }, mine.length
          ? `${plural(mine.length, 'paper')} claimed. Open a paper to write your note and update its status.`
          : 'You have not claimed any papers yet.'),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: '#/papers', onclick: () => { state.filters.status = 'open'; state.filters.tag = 'ranked'; } }, 'Find papers that need readers'),
          h('a', { class: 'btn btn-quiet', href: '#/profile' }, 'Edit my profile'))),
      groups,
      notesOnly.length ? h('section', { class: 'stack' }, h('h2', {}, 'Notes on papers you have not claimed'), h('div', { class: 'paper-list' }, notesOnly.map(paperRow))) : null,
      h('section', { class: 'stack' }, h('h2', {}, 'Export'), exportButtons())));
  }

  /* ---------- adding papers ---------- */

  function safeHref(url) { return url && /^https?:\/\//i.test(url) ? url : null; }
  function cleanDoi(text) {
    return text.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').replace(/[.\s]+$/, '');
  }
  function initials(given) {
    return (given || '').split(/[\s.-]+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('');
  }
  function paperWithDoi(doi, exceptId) {
    const d = doi.toLowerCase();
    return state.papers.find((x) => x.doi && x.doi.toLowerCase() === d && x.id !== exceptId);
  }

  // Look a DOI up in OpenAlex (which also knows about free full text), falling back to Crossref
  async function lookupDoi(doi) {
    const path = encodeURI(doi).replace(/[?#]/g, encodeURIComponent);
    try {
      const r = await fetch(`https://api.openalex.org/works/https://doi.org/${path}`);
      if (r.ok) {
        const w = await r.json();
        const src = w.primary_location && w.primary_location.source;
        const best = w.best_oa_location || {};
        return {
          doi, title: w.title, year: w.publication_year, journal: src ? src.display_name : '',
          authors: (w.authorships || []).map((a) => {
            const parts = a.author.display_name.split(' ');
            return { family: parts.pop(), given: parts.join(' ') };
          }),
          volume: w.biblio.volume, issue: w.biblio.issue,
          pages: [w.biblio.first_page, w.biblio.last_page].filter(Boolean).join('–'),
          preprint: w.type === 'preprint',
          is_oa: Boolean(w.open_access && w.open_access.is_oa),
          oa_status: w.open_access ? w.open_access.oa_status : null,
          oa_url: safeHref(w.open_access && w.open_access.oa_url), pdf_url: safeHref(best.pdf_url),
        };
      }
    } catch (err) { /* try Crossref */ }
    let r;
    try { r = await fetch(`https://api.crossref.org/works/${path}`); } catch (err) { r = null; }
    if (!r || !r.ok) {
      throw new Error(r && r.status === 404 ? 'No record found for this DOI. Check it, or fill in the details by hand.'
        : 'The lookup service is not responding. Fill in the details by hand.');
    }
    const m = (await r.json()).message;
    return {
      doi, title: (m.title || [])[0], year: (((m.issued || {})['date-parts'] || [[null]])[0] || [null])[0],
      journal: (m['short-container-title'] || [])[0] || (m['container-title'] || [])[0] || '',
      authors: (m.author || []).map((a) => ({ family: a.family || a.name || '', given: a.given || '' })),
      volume: m.volume, issue: m.issue, pages: m.page, preprint: m.type === 'posted-content',
    };
  }

  // Same style as the bibliography: "Surname AB, Surname C, et al. (2024). Title. Journal 6(5):e1–e9. doi:…"
  function formatCitation(m) {
    const names = m.authors.map((a) => `${a.family} ${initials(a.given)}`.trim());
    const authors = names.length > 3 ? `${names[0]}, et al.` : names.join(', ');
    const issue = m.volume ? `${m.volume}${m.issue ? `(${m.issue})` : ''}${m.pages ? `:${m.pages}` : ''}` : (m.pages || '');
    const where = [m.journal, issue].filter(Boolean).join(' ');
    return `${authors || 'Unknown authors'} (${m.year || 'n.d.'}). ${(m.title || '').replace(/\.$/, '')}. ${where ? `${where}. ` : ''}doi:${m.doi}`;
  }
  function formatShortCite(m) {
    const first = m.authors[0] ? m.authors[0].family : 'Unknown';
    return `${first}${m.authors.length > 1 ? ' et al.' : ''} ${m.year || 'n.d.'}${m.journal ? `, ${m.journal}` : ''}`;
  }

  function renderAdd() {
    const editing = state.editPaperId ? paperById(state.editPaperId) : null;
    const p = editing || {};
    let found = null; // record from the last DOI lookup
    const input = (id, props) => h('input', { type: 'text', id, ...props });
    const doi = input('a-doi', { value: p.doi || '', placeholder: '10.1038/… or a doi.org link' });
    const lookupMsg = h('p', { class: 'small muted', role: 'status' });
    const title = input('a-title', { required: true, maxlength: 500, value: p.title || '' });
    const short = input('a-short', { required: true, maxlength: 200, value: p.short_cite || '', placeholder: 'Surname et al. 2025, Journal' });
    const citation = h('textarea', { id: 'a-citation', required: true, maxlength: 2000, rows: 3, value: p.citation || '', placeholder: 'Authors (year). Title. Journal volume(issue):pages. doi:…' });
    const link = h('input', { type: 'url', id: 'a-url', value: p.doi ? (p.oa_url || '') : (p.url || ''), placeholder: 'https://…' });
    const section = h('select', { id: 'a-section', required: true },
      h('option', { value: '' }, 'Choose a section'),
      Object.entries(SECTIONS).map(([n, t]) => h('option', { value: n, selected: String(p.section || '') === n }, `§${n} ${t}`)));
    const tag = h('select', { id: 'a-tag' }, Object.entries(TAGS).map(([t, info]) =>
      h('option', { value: t, selected: (p.tag || 'should') === t }, `${info.label}${info.need === 2 ? ' (2 readers)' : ''}`)));
    const why = h('textarea', { id: 'a-why', maxlength: 2000, rows: 2, value: p.why_read || '', placeholder: 'What does it add to the chapter?' });
    const free = h('input', { type: 'checkbox', id: 'a-free', checked: p.is_oa });
    const preprint = h('input', { type: 'checkbox', id: 'a-preprint', checked: p.verify_flag === 'preprint' });
    const claimIt = h('input', { type: 'checkbox', id: 'a-claim', checked: true });

    const duplicateMessage = (other) => {
      lookupMsg.replaceChildren('This paper is already in the list: ',
        h('button', { class: 'paper-title', type: 'button', onclick: () => openPaper(other.id) }, shortCite(other)), '.');
    };

    const lookup = h('button', {
      class: 'btn btn-secondary', type: 'button',
      onclick: async () => {
        const d = cleanDoi(doi.value);
        if (!d) { lookupMsg.textContent = 'Type or paste a DOI first.'; return; }
        const other = paperWithDoi(d, p.id);
        if (other) { duplicateMessage(other); return; }
        lookup.disabled = true;
        lookupMsg.textContent = 'Looking it up…';
        try {
          found = await lookupDoi(d);
          doi.value = d;
          title.value = found.title || '';
          short.value = formatShortCite(found);
          citation.value = formatCitation(found);
          preprint.checked = found.preprint;
          if ('is_oa' in found) free.checked = found.is_oa;
          if (found.oa_url && !link.value) link.value = found.oa_url;
          lookupMsg.textContent = `Found: ${found.title}. Check the details below${found.is_oa ? '; a free full text is available' : ''}.`;
        } catch (err) {
          lookupMsg.textContent = err.message;
        } finally {
          lookup.disabled = false;
        }
      },
    }, 'Look up');

    const form = h('form', {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const d = cleanDoi(doi.value);
        const url = link.value.trim();
        if (!d && !url) { toast('Add a DOI or a link so the others can find the paper.', true); return; }
        if (url && !safeHref(url)) { toast('The link must start with http:// or https://', true); return; }
        const other = d && paperWithDoi(d, p.id);
        if (other) { duplicateMessage(other); toast('This paper is already in the list.', true); return; }
        const oa = found && found.doi.toLowerCase() === d.toLowerCase() ? found : null;
        const row = {
          section: Number(section.value), section_title: SECTIONS[section.value], tag: tag.value,
          title: title.value.trim(), short_cite: short.value.trim(), citation: citation.value.trim(),
          doi: d || null, url: d ? `https://doi.org/${d}` : url, why_read: why.value.trim() || null,
          is_oa: free.checked,
          oa_status: free.checked ? (oa && oa.oa_status) || p.oa_status || null : null,
          oa_url: free.checked ? url || (oa && oa.oa_url) || null : null,
          pdf_url: free.checked ? (oa && oa.pdf_url) || p.pdf_url || null : null,
          verify_flag: preprint.checked ? 'preprint' : 'verified',
        };
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        const query = editing
          ? state.sb.from('papers').update(row).eq('id', p.id).select()
          : state.sb.from('papers').insert({ ...row, added_by: uid() }).select();
        const { data, error } = await query;
        submit.disabled = false;
        if (error || !data.length) { toast(error ? friendlyError(error) : 'Could not save this paper.', true); return; }
        await loadTable('papers');
        state.editPaperId = null;
        if (!editing && claimIt.checked) await claim(data[0].id);
        toast(editing ? 'Changes saved.' : 'Added. Everyone can see it now.');
        state.filters = { ...state.filters, tag: 'added', status: '', q: '' };
        location.hash = '#/papers';
        openPaper(data[0].id);
      },
    },
    h('h2', {}, editing ? 'Edit the paper you added' : 'Add a paper'),
    editing ? null : h('p', { class: 'muted small' }, 'Found something the list is missing? Paste its DOI and click Look up to fill in the details, or type them in. The paper appears in everyone\'s list straight away.'),
    h('div', { class: 'field' }, h('label', { for: 'a-doi' }, 'DOI'),
      h('div', { class: 'input-row' }, doi, lookup), lookupMsg),
    h('div', { class: 'field' }, h('label', { for: 'a-title' }, 'Title'), title),
    h('div', { class: 'field' }, h('label', { for: 'a-short' }, 'Short citation'), short,
      h('span', { class: 'hint' }, 'How it is shown in lists, e.g. "Topol 2019, Nat Med".')),
    h('div', { class: 'field' }, h('label', { for: 'a-citation' }, 'Full citation'), citation),
    h('div', { class: 'field' }, h('label', { for: 'a-url' }, 'Link'), link,
      h('span', { class: 'hint' }, 'Needed if there is no DOI. Otherwise, optionally a free full-text copy (e.g. arXiv, PubMed Central).')),
    h('div', { class: 'row' },
      h('div', { class: 'field', style: 'flex:1;min-width:220px' }, h('label', { for: 'a-section' }, 'Chapter section'), section),
      h('div', { class: 'field', style: 'flex:1;min-width:220px' }, h('label', { for: 'a-tag' }, 'Priority'), tag)),
    h('div', { class: 'field' }, h('label', { for: 'a-why' }, 'Why read it (optional)'), why),
    h('label', { class: 'check' }, free, h('span', {}, 'Free to read online (open access)')),
    h('label', { class: 'check' }, preprint, h('span', {}, 'Preprint, not peer reviewed')),
    editing ? null : h('label', { class: 'check' }, claimIt, h('span', {}, 'I\'ll read it myself: claim it for me')),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'submit' }, editing ? 'Save changes' : 'Add to the list'),
      editing ? h('a', { class: 'btn btn-quiet', href: '#/papers', onclick: () => { state.editPaperId = null; } }, 'Cancel') : null));

    const mine = state.papers.filter((x) => x.added_by === uid()).sort((a, b) => b.created_at.localeCompare(a.created_at));
    mount(h('div', { class: 'stack-lg' }, form,
      mine.length ? h('section', { class: 'stack' }, h('h2', {}, `Papers you added (${mine.length})`),
        h('div', { class: 'paper-list' }, mine.map(paperRow))) : null));
  }

  function editPaper(pid) {
    state.editPaperId = pid;
    if (dialog.open) dialog.close();
    if (location.hash === '#/add') route(); else location.hash = '#/add';
  }

  async function removePaper(p) {
    if (!confirm('Remove this paper from the list? Your own claim and note on it go too.')) return;
    const { data, error } = await state.sb.from('papers').delete().eq('id', p.id).select('id');
    if (error) { toast(friendlyError(error), true); return; }
    if (!data.length) {
      toast('Other readers have claimed this paper or written notes on it, so it stays. Ask the chapter lead if it should go.', true);
      return;
    }
    dialog.close();
    await Promise.all(['papers', 'claims', 'notes'].map(loadTable));
    toast('Paper removed.');
    rerender();
  }

  /* ---------- chapter materials ---------- */

  const FILE_TYPES = {
    pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', bib: 'text/plain', ris: 'text/plain',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    odt: 'application/vnd.oasis.opendocument.text', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  };
  const MAX_FILE = 50 * 1024 * 1024;

  function fileSize(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
  function extension(name) { return (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || ''; }

  function openMaterial(m) { return openStored('materials', m.storage_path); }

  async function removeMaterial(m) {
    if (!confirm(`Remove "${m.title}" for everyone?`)) return;
    const { data, error } = await state.sb.from('materials').delete().eq('id', m.id).select('id');
    if (error || !data.length) { toast(error ? friendlyError(error) : 'Could not remove it.', true); return; }
    if (m.storage_path) await state.sb.storage.from('materials').remove([m.storage_path]);
    await loadTable('materials');
    toast('Removed.');
    drawMaterials();
  }

  function materialRow(m) {
    const mine = Boolean(m.added_by) && m.added_by === uid();
    let what;
    if (m.storage_path) what = `${(extension(m.file_name || '') || 'file').toUpperCase()} · ${fileSize(m.size_bytes || 0)}`;
    else { try { what = new URL(m.url).hostname.replace(/^www\./, ''); } catch (err) { what = 'Link'; } }
    const meta = [what, m.added_by ? `shared by ${mine ? 'you' : readerName(m.added_by)}` : null,
      new Date(m.created_at).toLocaleDateString()].filter(Boolean).join(' · ');
    return h('article', { class: 'material-row' },
      h('div', { class: 'material-main' },
        h('h3', {}, m.title),
        m.description ? h('p', { class: 'small' }, m.description) : null,
        h('p', { class: 'paper-meta' }, meta)),
      h('div', { class: 'row' },
        m.url ? h('a', { class: 'btn btn-secondary btn-small', href: safeHref(m.url), target: '_blank', rel: 'noopener noreferrer' }, 'Open link ↗')
          : h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => openMaterial(m) }, 'Open'),
        mine ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => removeMaterial(m) }, 'Remove') : null));
  }

  let leadHost, sharedHost, sharedHeading;
  function drawMaterials() {
    const lead = state.materials.filter((m) => m.sort_order !== null)
      .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
    const shared = state.materials.filter((m) => m.sort_order === null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    leadHost.replaceChildren(lead.length ? h('div', { class: 'paper-list' }, lead.map(materialRow))
      : h('p', { class: 'empty' }, 'The chapter lead has not added any documents yet.'));
    sharedHeading.textContent = `Shared by readers (${shared.length})`;
    sharedHost.replaceChildren(shared.length ? h('div', { class: 'paper-list' }, shared.map(materialRow))
      : h('p', { class: 'empty' }, 'Nothing shared yet.'));
  }

  function renderMaterials() {
    let kind = 'file';
    const title = h('input', { type: 'text', id: 'm-title', required: true, maxlength: 200, placeholder: 'e.g. Draft of §7, comments welcome' });
    const description = h('textarea', { id: 'm-description', maxlength: 1000, rows: 2, placeholder: 'Optional: what is it, and what should people do with it?' });
    const file = h('input', { type: 'file', id: 'm-file', accept: Object.keys(FILE_TYPES).map((x) => `.${x}`).join(',') });
    const link = h('input', { type: 'url', id: 'm-link', placeholder: 'https://docs.google.com/…' });
    const fileField = h('div', { class: 'field' }, h('label', { for: 'm-file' }, 'File'), file,
      h('span', { class: 'hint' }, 'PDF, Word, PowerPoint, Excel, Markdown, text, CSV, BibTeX/RIS or images; up to 50 MB.'));
    const linkField = h('div', { class: 'field', hidden: true }, h('label', { for: 'm-link' }, 'Link'), link,
      h('span', { class: 'hint' }, 'For example a shared Google Doc or Overleaf project. Check that its sharing settings let the others open it.'));
    const status = h('p', { class: 'small muted', role: 'status' });
    const button = h('button', { class: 'btn', type: 'submit' }, 'Share with the team');
    const choose = (value) => {
      kind = value;
      fileField.hidden = value !== 'file';
      linkField.hidden = value !== 'link';
    };
    const radio = (value, label) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'm-kind', value, checked: value === 'file', onchange: () => choose(value) }), h('span', {}, label));

    const form = h('form', {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const row = { title: title.value.trim(), description: description.value.trim() || null, added_by: uid() };
        let path = null;
        if (kind === 'link') {
          if (!safeHref(link.value.trim())) { toast('The link must start with http:// or https://', true); return; }
          row.url = link.value.trim();
        } else {
          const f = file.files[0];
          if (!f) { toast('Choose a file first.', true); return; }
          const type = FILE_TYPES[extension(f.name)];
          if (!type) { toast('That file type is not accepted here.', true); return; }
          if (f.size > MAX_FILE) { toast('Files can be up to 50 MB.', true); return; }
          button.disabled = true;
          status.textContent = `Uploading ${f.name}…`;
          const safeName = f.name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(-80);
          path = `readers/${uid()}/${Date.now()}-${safeName}`;
          const { error } = await state.sb.storage.from('materials').upload(path, f, { contentType: type, upsert: false });
          if (error) { button.disabled = false; status.textContent = ''; toast(friendlyError(error), true); return; }
          Object.assign(row, { storage_path: path, file_name: f.name, size_bytes: f.size });
        }
        button.disabled = true;
        const { error } = await state.sb.from('materials').insert(row);
        button.disabled = false;
        status.textContent = '';
        if (error) {
          if (path) await state.sb.storage.from('materials').remove([path]);
          toast(friendlyError(error), true);
          return;
        }
        await loadTable('materials');
        toast('Shared with the team.');
        renderMaterials();
      },
    },
    h('h2', {}, 'Share a document'),
    h('p', { class: 'muted small' }, 'Drafts, figures, notes from a meeting, a useful report. Everyone signed in to the tracker can open it. To share the PDF of a paper on the list, upload it on the paper itself (open it from Papers).'),
    h('div', { class: 'field' }, h('label', { for: 'm-title' }, 'Title'), title),
    h('div', { class: 'field' }, h('label', { for: 'm-description' }, 'Description'), description),
    h('div', { class: 'row', role: 'radiogroup', 'aria-label': 'What are you sharing?' }, radio('file', 'Upload a file'), radio('link', 'Add a link')),
    fileField, linkField,
    h('div', { class: 'row' }, button, status));

    mount(h('div', { class: 'stack-lg' },
      h('div', { class: 'stack' },
        h('h1', {}, 'Chapter materials'),
        h('p', { class: 'muted' }, 'The chapter plan and supporting documents, plus anything the team shares. Files are private to signed-in readers.')),
      h('section', { class: 'stack' }, h('h2', {}, 'Chapter documents'), leadHost = h('div')),
      h('section', { class: 'stack' }, sharedHeading = h('h2'), sharedHost = h('div')),
      form));
    drawMaterials();
  }

  /* ---------- writing the chapter ---------- */

  const STAGES = {
    reading: ['Reading', 'Claim papers and take notes. The AI draft of the chapter will appear here.'],
    claim_review: ['Checking claims', 'The AI draft is up. Open each paper you are reading: under "In the draft" its claims are shown in their sentences. Mark each one supported, needs change or not supported, add claims or information, or reject the paper.'],
    section_review: ['Editing and approving', 'The draft has been rebuilt from your feedback. Edit the text where needed, then approve sections. Each section needs two approvals of its latest version.'],
    final: ['Final', 'The chapter has been assembled. The Word file is on the Materials page.'],
  };
  const VERDICTS = { supported: 'Supported', needs_change: 'Needs change', not_supported: 'Not supported' };
  const DECISIONS = { approve: 'Approve', approve_with_additions: 'Approve with additions', reject: 'Reject the paper' };
  const CITE_RE = /\[@([^\]]+)\]/g;
  const INLINE_RE = /\[@[^\]]+\]|\*\*[^*]+\*\*|\*[^*\s][^*]*\*/g;
  const WORD_LIMIT = [5000, 6000];

  function stage() { return (state.chapter_state[0] || {}).stage || 'reading'; }
  function sectionInfo(s) {
    return state.chapter_sections.find((x) => x.section === s) || { section: s, title: SECTIONS[s], word_budget: 0, citation_budget: 0 };
  }
  function versionsOf(s) { return state.section_versions.filter((v) => v.section === s).sort((a, b) => a.version - b.version); }
  function latestVersion(s) { const v = versionsOf(s); return v[v.length - 1] || null; }
  function approvalsOf(versionId) { return state.section_approvals.filter((a) => a.section_version_id === versionId); }
  function claimsOfPaper(pid) { return state.draft_claims.filter((c) => c.paper_id === pid); }
  function reviewsOf(claimId) { return state.claim_reviews.filter((r) => r.claim_id === claimId); }
  function myReview(claimId) { return state.claim_reviews.find((r) => r.claim_id === claimId && r.user_id === uid()); }
  function myDecision(pid) { return state.paper_reviews.find((r) => r.paper_id === pid && r.user_id === uid()); }
  function filesOf(pid) { return state.paper_files.filter((f) => f.paper_id === pid); }
  function needsMyCheck(pid) {
    const claims = claimsOfPaper(pid).filter((c) => c.basis !== 'reader' && c.status !== 'dropped');
    return claims.length > 0 && (claims.some((c) => !myReview(c.id)) || !myDecision(pid));
  }

  function parseCite(inner) {
    return inner.split(';').map((s) => s.trim().replace(/^@/, '').trim()).filter(Boolean).map((s) => {
      const i = s.indexOf(',');
      return i < 0 ? { key: s, pin: '' } : { key: s.slice(0, i).trim(), pin: s.slice(i + 1).trim() };
    });
  }

  // Same rule as scripts/chapter_lib.py: tokens with a letter or digit; citation keys don't count
  function countWords(text) {
    return (text || '').replace(CITE_RE, ' ').replace(/[#*_>`]/g, ' ').split(/\s+/)
      .filter((t) => /[0-9A-Za-zÀ-ÿ]/.test(t)).length;
  }

  function withPin(full, pin) {
    const f = full.trim().replace(/\.$/, '');
    if (!pin) return f;
    const i = f.indexOf(' <http');
    return i >= 0 ? `${f.slice(0, i)} ${pin}${f.slice(i)}` : `${f}, ${pin}`;
  }

  // Footnotes numbered across the chapter: the full OSCOLA form first, then "Short (n X)", or "ibid"
  function buildFootnotes(bodies) {
    const first = new Map();
    const out = {};
    let n = 0;
    let previous = null;
    for (const [section, body] of bodies) {
      const notes = [];
      for (const m of body.matchAll(CITE_RE)) {
        n += 1;
        const cites = parseCite(m[1]);
        const parts = cites.map(({ key, pin }) => {
          const p = paperById(key);
          if (!p) return `[unknown reference: ${key}]`;
          if (cites.length === 1 && previous && previous.length === 1 && previous[0].key === key) return `ibid${pin ? ' ' + pin : ''}`;
          if (!first.has(key)) { first.set(key, n); return withPin(p.oscola || p.citation, pin); }
          return `${p.oscola_short || p.short_cite || key} (n ${first.get(key)})${pin ? ' ' + pin : ''}`;
        });
        notes.push({ start: m.index, end: m.index + m[0].length, n, text: `${parts.join('; ')}.`, keys: cites.map((c) => c.key) });
        previous = cites;
      }
      out[section] = notes;
    }
    return out;
  }

  // Words per section and for the whole chapter (abstract, headings, text and footnotes), as build_docx.py counts them
  function chapterCounts(override) {
    const bodies = [];
    for (let s = 1; s <= 9; s += 1) {
      if (override && override.section === s) bodies.push([s, override.body]);
      else { const v = latestVersion(s); if (v) bodies.push([s, v.body]); }
    }
    const notes = buildFootnotes(bodies);
    const per = {};
    let total = countWords((state.chapter_state[0] || {}).abstract || '');
    for (const [s, body] of bodies) {
      const text = countWords(body);
      const fn = notes[s].reduce((sum, x) => sum + countWords(x.text), 0);
      per[s] = { text, notes: fn, cites: new Set(notes[s].flatMap((x) => x.keys)).size };
      total += text + fn + countWords(`${s}. ${sectionInfo(s).title}`);
    }
    return { per, total, notes };
  }

  function italics(text) {
    // Footnotes: *title* in italics, everything else as text
    return text.split(/(\*[^*]+\*)/).filter(Boolean).map((part) => (/^\*[^*]+\*$/.test(part) ? h('em', {}, part.slice(1, -1)) : part));
  }

  // Our Markdown subset as DOM nodes, never HTML: paragraphs, ## and ### headings, *italic*, **bold**,
  // and citation keys as footnote numbers. Claim anchors found in the text are highlighted.
  function renderText(body, opts) {
    const o = opts || {};
    const noteAt = new Map((o.notes || []).map((x) => [x.start, x]));
    const ranges = [];
    for (const c of o.claims || []) {
      const i = c.anchor ? body.indexOf(c.anchor) : -1;
      if (i >= 0) ranges.push({ start: i, end: i + c.anchor.length, claim: c });
    }
    const claimAt = (pos) => ranges.find((r) => pos >= r.start && pos < r.end);
    const mark = (claim, content) => h('mark', {
      class: `claim claim-${claim.status}`, title: `${shortCite(paperById(claim.paper_id) || {})}: ${claim.claim}`,
      tabindex: o.onClaim ? '0' : null, role: o.onClaim ? 'button' : null,
      onclick: o.onClaim ? () => o.onClaim(claim) : null,
      onkeydown: o.onClaim ? (e) => { if (e.key === 'Enter') o.onClaim(claim); } : null,
    }, content);
    const emit = (parent, text, start) => {
      let i = 0;
      while (i < text.length) {
        const r = claimAt(start + i);
        let j = i + 1;
        while (j < text.length && claimAt(start + j) === r) j += 1;
        const piece = text.slice(i, j);
        parent.append(r ? mark(r.claim, piece) : piece);
        i = j;
      }
    };
    const inline = (parent, text, base) => {
      let last = 0;
      for (const m of text.matchAll(INLINE_RE)) {
        if (m.index > last) emit(parent, text.slice(last, m.index), base + last);
        const tok = m[0];
        const abs = base + m.index;
        if (tok.startsWith('[@')) {
          const note = noteAt.get(abs);
          const sup = h('sup', { class: 'fn', title: note ? note.text.replace(/\*/g, '') : '' }, note ? String(note.n) : '*');
          const r = claimAt(abs);
          parent.append(r ? mark(r.claim, sup) : sup);
        } else {
          const strong = tok.startsWith('**');
          const el = h(strong ? 'strong' : 'em');
          emit(el, tok.slice(strong ? 2 : 1, strong ? -2 : -1), abs + (strong ? 2 : 1));
          parent.append(el);
        }
        last = m.index + tok.length;
      }
      if (last < text.length) emit(parent, text.slice(last), base + last);
    };
    const blocks = [];
    const re = /\n[ \t]*\n/g;
    let pos = 0;
    let m;
    const chunks = [];
    while ((m = re.exec(body)) !== null) { chunks.push([pos, body.slice(pos, m.index)]); pos = m.index + m[0].length; }
    chunks.push([pos, body.slice(pos)]);
    for (const [start, raw] of chunks) {
      const text = raw.trimStart();
      if (!text.trim()) continue;
      const offset = start + raw.length - text.length;
      const head = text.match(/^(#{2,4})\s+/);
      const el = head ? h(head[1].length <= 2 ? 'h3' : 'h4', { class: 'chapter-sub' }) : h('p');
      inline(el, text.slice(head ? head[0].length : 0).trimEnd(), offset + (head ? head[0].length : 0));
      blocks.push(el);
    }
    return blocks;
  }

  // Word-level differences between two versions
  function diffWords(a, b) {
    const x = a.match(/\S+\s*/g) || [];
    const y = b.match(/\S+\s*/g) || [];
    if (x.length * y.length > 4e6) return [h('p', { class: 'muted' }, 'These versions are too long to compare word by word.')];
    const w = y.length + 1;
    const dp = new Int32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i -= 1) {
      for (let j = y.length - 1; j >= 0; j -= 1) {
        dp[i * w + j] = x[i].trim() === y[j].trim() ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const out = [];
    const push = (kind, text) => {
      const lastNode = out[out.length - 1];
      if (lastNode && lastNode.kind === kind) lastNode.text += text; else out.push({ kind, text });
    };
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i].trim() === y[j].trim()) { push('same', y[j]); i += 1; j += 1; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { push('del', x[i]); i += 1; }
      else { push('ins', y[j]); j += 1; }
    }
    while (i < x.length) { push('del', x[i]); i += 1; }
    while (j < y.length) { push('ins', y[j]); j += 1; }
    return [h('div', { class: 'diff' }, out.map((part) => (part.kind === 'same' ? part.text : h(part.kind, {}, part.text))))];
  }

  function stageBanner() {
    const [label, text] = STAGES[stage()];
    return h('div', { class: 'stage-banner' }, h('strong', {}, label), h('span', {}, text));
  }

  function renderChapter(arg, sub) {
    const s = Number(arg);
    if (s >= 1 && s <= 9) {
      if (sub === 'history') renderHistory(s);
      else renderSection(s);
      return;
    }
    const counts = chapterCounts();
    const written = state.section_versions.length > 0;
    const rows = Object.keys(SECTIONS).map(Number).map((sec) => {
      const info = sectionInfo(sec);
      const v = latestVersion(sec);
      const c = counts.per[sec];
      const claims = state.draft_claims.filter((x) => x.section === sec && x.basis !== 'reader' && x.status !== 'dropped');
      const reviewed = claims.filter((x) => reviewsOf(x.id).length).length;
      const approvals = v ? approvalsOf(v.id).length : 0;
      return h('tr', {},
        h('td', {}, v ? h('a', { href: `#/chapter/${sec}` }, `${sec}. ${info.title}`) : `${sec}. ${info.title}`),
        h('td', {}, v ? `v${v.version} · ${v.created_by ? readerName(v.created_by) : 'AI'}` : (sec === 1 || sec === 9 ? 'written last' : 'not yet')),
        h('td', { class: 'num' + (c && c.text > info.word_budget * 1.1 ? ' over' : '') }, `${c ? c.text : '—'} / ${info.word_budget}`),
        h('td', { class: 'num' }, c ? String(c.notes) : '—'),
        h('td', { class: 'num' }, claims.length ? `${reviewed} / ${claims.length}` : '—'),
        h('td', { class: 'num' + (approvals >= 2 ? ' ok' : '') }, v && sec >= 2 && sec <= 8 ? `${approvals} / 2` : '—'));
    });
    const pct = Math.min(100, (100 * counts.total) / WORD_LIMIT[1]);
    mount(h('div', { class: 'stack-lg' },
      h('div', { class: 'stack' }, h('h1', {}, 'The chapter'), stageBanner()),
      written ? h('section', { class: 'card stack' },
        h('h2', {}, 'Length'),
        h('p', {}, `${counts.total.toLocaleString()} words, counting the abstract, headings and footnotes. The publisher's limit is ${WORD_LIMIT[0].toLocaleString()}–${WORD_LIMIT[1].toLocaleString()} words including references.`),
        h('div', { class: 'bar', role: 'img', 'aria-label': `${counts.total} of ${WORD_LIMIT[1]} words` },
          h('div', { class: counts.total > WORD_LIMIT[1] ? 'bar-over' : 'bar-done', style: `width:${pct}%` })))
        : h('p', { class: 'empty' }, 'The AI draft has not been posted yet. Until then, keep reading and taking notes.'),
      h('section', { class: 'stack' },
        h('h2', {}, 'Sections'),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('tr', {}, h('th', {}, 'Section'), h('th', {}, 'Latest version'), h('th', { class: 'num' }, 'Words / budget'),
            h('th', { class: 'num' }, 'Footnote words'), h('th', { class: 'num' }, 'Claims checked'), h('th', { class: 'num' }, 'Approvals')),
          rows)))));
  }

  async function approveSection(v, approve) {
    const query = approve
      ? state.sb.from('section_approvals').insert({ section_version_id: v.id, user_id: uid() })
      : state.sb.from('section_approvals').delete().eq('section_version_id', v.id).eq('user_id', uid());
    const { error } = await query;
    if (error) { toast(friendlyError(error), true); return; }
    await loadTable('section_approvals');
    toast(approve ? 'Approved.' : 'Approval withdrawn.');
    renderSection(v.section);
  }

  function renderSection(s) {
    if (state.editing && state.editing.section === s) { renderEditor(s); return; }
    const info = sectionInfo(s);
    const v = latestVersion(s);
    const back = h('a', { href: '#/chapter' }, '← The chapter');
    if (!v) {
      mount(h('div', { class: 'stack' }, back, h('h1', {}, `${s}. ${info.title}`), h('p', { class: 'empty' }, 'Not written yet.')));
      return;
    }
    const counts = chapterCounts();
    const notes = counts.notes[s] || [];
    const c = counts.per[s];
    const claims = state.draft_claims.filter((x) => x.section === s && x.anchor);
    const approvals = approvalsOf(v.id);
    const iApproved = approvals.some((a) => a.user_id === uid());
    const earlier = !iApproved && state.section_approvals.some((a) => a.user_id === uid() && versionsOf(s).some((x) => x.id === a.section_version_id));
    const reviewable = s >= 2 && s <= 8;
    const open = stage() === 'section_review' && reviewable;
    const claimItem = (cl) => {
      const p = paperById(cl.paper_id) || {};
      const verdicts = reviewsOf(cl.id).map((r) => VERDICTS[r.verdict]);
      const found = v.body.includes(cl.anchor);
      return h('li', { class: 'claim-item' },
        h('button', { class: 'paper-title', type: 'button', onclick: () => openPaper(cl.paper_id) }, shortCite(p)),
        h('p', { class: 'small' }, cl.claim),
        h('p', { class: 'small muted' }, [verdicts.length ? verdicts.join(', ') : 'Not checked yet',
          cl.status !== 'open' ? ` · ${cl.status}` : '', found ? '' : ' · no longer in this version'].join('')));
    };
    mount(h('div', { class: 'stack-lg' },
      h('div', { class: 'stack' },
        back,
        h('h1', {}, `${s}. ${info.title}`),
        h('p', { class: 'muted' }, `Version ${v.version} by ${v.created_by ? readerName(v.created_by) : 'the AI'}, ${new Date(v.created_at).toLocaleString()}`
          + `${v.change_note ? ` — ${v.change_note}` : ''}`),
        h('p', { class: 'small' + (c.text > info.word_budget * 1.1 ? ' over' : '') },
          `${c.text} words of text (budget ${info.word_budget}) + ${c.notes} words in ${plural(notes.length, 'footnote')} · chapter total ${counts.total.toLocaleString()} of ${WORD_LIMIT[1].toLocaleString()}`),
        stageBanner(),
        h('div', { class: 'row' },
          open ? h('button', { class: iApproved ? 'btn btn-secondary' : 'btn', type: 'button', onclick: () => approveSection(v, !iApproved) },
            iApproved ? 'Withdraw my approval' : 'Approve this version') : null,
          reviewable ? h('span', { class: 'small ' + (approvals.length >= 2 ? 'ok' : 'muted') },
            `${approvals.length} of 2 approvals${approvals.length ? `: ${approvals.map((a) => (a.user_id === uid() ? 'you' : readerName(a.user_id))).join(', ')}` : ''}`) : null,
          earlier ? h('span', { class: 'badge badge-warn' }, 'You approved an earlier version') : null,
          open ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => startEdit(s) }, 'Edit the text') : null,
          versionsOf(s).length > 1 ? h('a', { class: 'btn btn-quiet', href: `#/chapter/${s}/history` }, `History (${versionsOf(s).length} versions)`) : null)),
      h('div', { class: 'chapter-layout' },
        h('article', { class: 'chapter-text card' },
          renderText(v.body, { notes, claims, onClaim: (cl) => openPaper(cl.paper_id) }),
          notes.length ? h('ol', { class: 'footnotes', start: String(notes[0].n) }, notes.map((x) => h('li', { value: String(x.n) }, italics(x.text)))) : null),
        claims.length ? h('aside', { class: 'chapter-claims stack' },
          h('h2', {}, `Claims (${claims.length})`),
          h('p', { class: 'small muted' }, 'Highlighted in the text. Click one to open its paper.'),
          h('ol', { class: 'list-plain' }, claims.map(claimItem))) : null)));
  }

  function startEdit(s) {
    const v = latestVersion(s);
    state.editing = { section: s, base: v.version, body: v.body, note: '' };
    renderSection(s);
  }

  function renderEditor(s) {
    const ed = state.editing;
    const info = sectionInfo(s);
    const counts = h('p', { class: 'small', role: 'status' });
    const area = h('textarea', { id: 'ed-body', class: 'editor', rows: '22', spellcheck: 'true', 'aria-label': `Text of section ${s}`, value: ed.body });
    const preview = h('div', { class: 'chapter-text card', hidden: true });
    const update = () => {
      ed.body = area.value;
      const c = chapterCounts({ section: s, body: area.value });
      counts.textContent = `${c.per[s].text} words of text (budget ${info.word_budget}) + ${c.per[s].notes} in footnotes · chapter total ${c.total.toLocaleString()} of ${WORD_LIMIT[1].toLocaleString()}`;
      counts.classList.toggle('over', c.total > WORD_LIMIT[1] || c.per[s].text > info.word_budget * 1.1);
      if (!preview.hidden) preview.replaceChildren(...renderText(area.value, { notes: c.notes[s] }));
    };
    area.addEventListener('input', update);
    const insert = (text) => {
      const at = area.selectionStart ?? area.value.length;
      area.value = area.value.slice(0, at) + text + area.value.slice(area.selectionEnd ?? at);
      area.focus();
      area.selectionStart = area.selectionEnd = at + text.length;
      update();
    };
    const results = h('div', { class: 'cite-results' });
    const search = h('input', {
      type: 'search', placeholder: 'Find a paper to cite…', 'aria-label': 'Find a paper to cite',
      oninput: (e) => {
        const q = e.target.value.trim().toLowerCase();
        const hits = q.length < 2 ? [] : state.papers.filter((p) => `${p.short_cite} ${p.title} ${p.citation}`.toLowerCase().includes(q)).slice(0, 8);
        results.replaceChildren(...hits.map((p) => h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => insert(`[@${p.id}]`) },
          `${shortCite(p)} — ${(p.title || '').slice(0, 70)}`)));
      },
    });
    const note = h('input', { type: 'text', id: 'ed-note', maxlength: '500', value: ed.note, placeholder: 'What did you change? Shown in the history.', oninput: (e) => { ed.note = e.target.value; } });
    const save = async (e) => {
      e.target.disabled = true;
      const { data, error } = await state.sb.from('section_versions')
        .insert({ section: s, version: ed.base + 1, body: area.value, change_note: note.value.trim() || null, created_by: uid() }).select();
      e.target.disabled = false;
      if (error) {
        toast(/newer version/i.test(error.message)
          ? 'Someone else saved a newer version while you were editing. Your text is still here: copy it, then Cancel to see their version and edit again.'
          : friendlyError(error), true);
        return;
      }
      state.editing = null;
      await loadTable('section_versions');
      toast(`Saved as version ${data[0].version}. Approvals start again for this version.`);
      renderSection(s);
    };
    mount(h('div', { class: 'stack' },
      h('h1', {}, `Editing ${s}. ${info.title}`),
      h('p', { class: 'muted small' }, 'Cite a paper with its key in square brackets: [@paper-key], with a page if you like: [@paper-key, 47]. Use the search below to insert keys. Footnotes are numbered and written in OSCOLA automatically. Leave a blank line between paragraphs; *italic*, **bold** and ### subheadings work.'),
      h('div', { class: 'stack', style: 'gap:6px' }, search, results),
      area, counts,
      h('div', { class: 'field' }, h('label', { for: 'ed-note' }, 'Change note'), note),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: save }, 'Save as a new version'),
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { preview.hidden = !preview.hidden; update(); } }, 'Show or hide preview'),
        h('button', {
          class: 'btn btn-quiet', type: 'button',
          onclick: () => {
            if (area.value !== latestVersion(s).body && !confirm('Discard your changes?')) return;
            state.editing = null;
            renderSection(s);
          },
        }, 'Cancel')),
      preview));
    update();
  }

  function renderHistory(s) {
    const versions = versionsOf(s).slice().reverse();
    const pick = (v) => {
      const prev = versionsOf(s).find((x) => x.version === v.version - 1);
      panel.replaceChildren(
        h('h2', {}, `Version ${v.version}${prev ? ` compared with version ${prev.version}` : ''}`),
        h('p', { class: 'small muted' }, 'Added words are highlighted; removed words are struck through.'),
        ...(prev ? diffWords(prev.body, v.body) : renderText(v.body)));
    };
    const panel = h('div', { class: 'card stack' });
    mount(h('div', { class: 'stack-lg' },
      h('div', { class: 'stack' },
        h('a', { href: `#/chapter/${s}` }, `← ${s}. ${sectionInfo(s).title}`),
        h('h1', {}, 'History')),
      h('ol', { class: 'list-plain' }, versions.map((v) => h('li', {},
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => pick(v) }, `Version ${v.version}`),
        h('span', { class: 'small muted' }, ` ${v.created_by ? readerName(v.created_by) : 'AI'}, ${new Date(v.created_at).toLocaleString()} · ${approvalsOf(v.id).length} approval(s)${v.change_note ? ` — ${v.change_note}` : ''}`)))),
      panel));
    pick(versions[0]);
  }

  /* ---------- claims and PDFs in the paper dialog ---------- */

  async function saveReview(claim, row) {
    const { error } = await state.sb.from('claim_reviews').upsert({ claim_id: claim.id, user_id: uid(), ...row });
    if (error) { toast(friendlyError(error), true); return false; }
    return true;
  }

  async function refreshDraftPart(p, message) {
    await Promise.all(['draft_claims', 'claim_reviews', 'paper_reviews'].map(loadTable));
    const node = document.getElementById('dlg-draft');
    if (node) node.replaceWith(draftPart(p));
    if (message) toast(message);
  }

  function claimCard(p, claim, index, total, open) {
    const mine = myReview(claim.id) || {};
    let verdict = mine.verdict || '';
    const others = reviewsOf(claim.id).filter((r) => r.user_id !== uid());
    const basis = claim.basis === 'full_text' ? ['badge-oa', 'Drafted from the full text']
      : claim.basis === 'abstract' ? ['badge-warn', 'Drafted from the abstract only: check carefully']
        : ['badge-status', `Added by ${claim.added_by === uid() ? 'you' : readerName(claim.added_by)}`];
    const page = h('input', { type: 'text', maxlength: '100', value: mine.page || '', 'aria-label': 'Page' });
    const wording = h('input', { type: 'text', maxlength: '4000', value: mine.suggested_wording || '', 'aria-label': 'Suggested wording', placeholder: 'optional' });
    const comment = h('textarea', { rows: '2', maxlength: '4000', value: mine.comment || '', 'aria-label': 'Comment', placeholder: 'optional' });
    const buttons = Object.entries(VERDICTS).map(([key, label]) => h('button', {
      class: `verdict verdict-${key}`, type: 'button', 'aria-pressed': String(verdict === key),
      onclick: (e) => {
        verdict = key;
        e.target.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target)));
      },
    }, label));
    const quote = claim.anchor ? claim.anchor.replace(CITE_RE, '').trim() : null;
    return h('article', { class: 'claim-card' },
      h('div', { class: 'row' },
        h('span', { class: 'small muted' }, `Claim ${index + 1} of ${total}${claim.section ? ` · §${claim.section}` : ''}`),
        h('span', { class: `badge ${basis[0]}` }, basis[1]),
        claim.status !== 'open' ? h('span', { class: 'badge badge-status' }, claim.status === 'addressed' ? 'Addressed in the rebuild' : 'Dropped in the rebuild') : null,
        claim.section && claim.anchor ? h('a', { class: 'small', href: `#/chapter/${claim.section}`, onclick: () => dialog.close() }, `Open §${claim.section}`) : null),
      quote ? h('blockquote', {}, quote) : null,
      h('p', {}, h('strong', {}, claim.anchor ? 'What the chapter says the paper shows: ' : 'Claim: '), claim.claim,
        claim.pinpoint ? h('span', { class: 'muted' }, ` (p ${claim.pinpoint})`) : null),
      others.length ? h('ul', { class: 'small list-plain' }, others.map((r) => h('li', {},
        h('strong', {}, `${readerName(r.user_id)}: ${VERDICTS[r.verdict]}`),
        [r.page ? ` · p ${r.page}` : '', r.suggested_wording ? ` · suggests: "${r.suggested_wording}"` : '', r.comment ? ` · ${r.comment}` : ''].join('')))) : null,
      open && claim.basis !== 'reader' ? [
        h('div', { class: 'choice', role: 'group', 'aria-label': 'Your verdict' }, buttons),
        h('div', { class: 'claim-fields' },
          h('div', { class: 'field' }, h('label', {}, 'Page', page)),
          h('div', { class: 'field' }, h('label', {}, 'Suggested wording', wording))),
        h('div', { class: 'field' }, h('label', {}, 'Comment', comment)),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn btn-small', type: 'button',
            onclick: async () => {
              if (!verdict) { toast('Choose Supported, Needs change or Not supported first.', true); return; }
              if (await saveReview(claim, { verdict, page: page.value.trim() || null, suggested_wording: wording.value.trim() || null, comment: comment.value.trim() || null })) {
                refreshDraftPart(p, 'Saved.');
              }
            },
          }, mine.verdict ? 'Update my check' : 'Save my check'),
          mine.verdict ? h('span', { class: 'small muted' }, `You said: ${VERDICTS[mine.verdict]}`) : null)] : null,
      open && claim.basis === 'reader' && claim.added_by === uid() ? h('button', {
        class: 'btn btn-quiet btn-small', type: 'button',
        onclick: async () => {
          if (!confirm('Remove this claim?')) return;
          const { error } = await state.sb.from('draft_claims').delete().eq('id', claim.id);
          if (error) { toast(friendlyError(error), true); return; }
          refreshDraftPart(p, 'Claim removed.');
        },
      }, 'Remove my claim') : null);
  }

  function draftPart(p) {
    const claims = claimsOfPaper(p.id);
    const open = stage() === 'claim_review';
    if (!claims.length && !open) return h('section', { id: 'dlg-draft', hidden: true });
    const decision = myDecision(p.id) || {};
    const others = state.paper_reviews.filter((r) => r.paper_id === p.id && r.user_id !== uid());
    let choice = decision.decision || '';
    const extra = h('textarea', { rows: '3', maxlength: '6000', value: decision.extra_info || '', 'aria-label': 'Extra information', placeholder: 'Extra information for the chapter, with pages (for "approve with additions")' });
    const reason = h('textarea', { rows: '2', maxlength: '4000', value: decision.reason || '', 'aria-label': 'Reason for rejecting', placeholder: 'Why should the chapter not cite this paper? (for "reject")' });
    const newClaim = h('textarea', { rows: '2', maxlength: '2000', 'aria-label': 'New claim', placeholder: 'What else does the paper show that the chapter should say?' });
    const newPage = h('input', { type: 'text', maxlength: '100', 'aria-label': 'Page of the new claim', placeholder: 'Page' });
    const saveDecision = async (value, extraText, reasonText) => {
      const { error } = await state.sb.from('paper_reviews').upsert({
        paper_id: p.id, user_id: uid(), decision: value, extra_info: extraText || null, reason: reasonText || null,
      });
      if (error) { toast(friendlyError(error), true); return false; }
      return true;
    };
    const aiClaims = claims.filter((c) => c.basis !== 'reader' && c.status !== 'dropped');
    return h('section', { class: 'stack', id: 'dlg-draft' },
      h('h3', {}, `In the draft (${plural(claims.length, 'claim')})`),
      open ? h('p', { class: 'small muted' }, 'Check each claim against the paper, then give your decision on the paper below.') : null,
      claims.length ? claims.map((c, i) => claimCard(p, c, i, claims.length, open)) : h('p', { class: 'muted small' }, 'The draft does not cite this paper.'),
      others.length ? h('ul', { class: 'small list-plain' }, others.map((r) => h('li', {},
        h('strong', {}, `${readerName(r.user_id)}: ${DECISIONS[r.decision]}`),
        r.extra_info ? ` · ${r.extra_info}` : '', r.reason ? ` · ${r.reason}` : ''))) : null,
      open ? h('div', { class: 'card stack decision' },
        h('h4', {}, 'Your decision on the paper'),
        h('div', { class: 'choice', role: 'group', 'aria-label': 'Your decision' }, Object.entries(DECISIONS).map(([key, label]) => h('button', {
          class: `verdict verdict-${key}`, type: 'button', 'aria-pressed': String(choice === key),
          onclick: (e) => {
            choice = key;
            e.target.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target)));
          },
        }, label))),
        extra, reason,
        h('div', { class: 'row' },
          h('button', {
            class: 'btn btn-small', type: 'button',
            onclick: async () => {
              if (!choice) { toast('Choose a decision first.', true); return; }
              if (choice === 'reject' && !reason.value.trim()) { toast('Say briefly why the paper should not be cited.', true); return; }
              if (await saveDecision(choice, extra.value.trim(), reason.value.trim())) refreshDraftPart(p, 'Decision saved.');
            },
          }, 'Save my decision'),
          aiClaims.length ? h('button', {
            class: 'btn btn-secondary btn-small', type: 'button',
            onclick: async () => {
              for (const c of aiClaims.filter((x) => !myReview(x.id))) {
                if (!(await saveReview(c, { verdict: 'supported' }))) return;
              }
              if (await saveDecision('approve', extra.value.trim(), null)) refreshDraftPart(p, 'Approved as drafted: every claim marked supported.');
            },
          }, 'Approve as drafted') : null,
          decision.decision ? h('span', { class: 'small muted' }, `You said: ${DECISIONS[decision.decision]}`) : null)) : null,
      open ? h('div', { class: 'stack', style: 'gap:8px' },
        h('h4', {}, 'Add a claim'),
        newClaim,
        h('div', { class: 'row' }, newPage,
          h('button', {
            class: 'btn btn-secondary btn-small', type: 'button',
            onclick: async () => {
              const text = newClaim.value.trim();
              if (text.length < 3) { toast('Write the claim first.', true); return; }
              const { error } = await state.sb.from('draft_claims').insert({
                paper_id: p.id, section: p.section, claim: text, pinpoint: newPage.value.trim() || null, basis: 'reader', added_by: uid(),
              });
              if (error) { toast(friendlyError(error), true); return; }
              refreshDraftPart(p, 'Claim added.');
            },
          }, 'Add claim'))) : null);
  }

  async function openStored(bucket, path) {
    // Open the tab straight away (pop-up blockers stop tabs opened after a wait), then send it to a short-lived link
    const win = window.open('', '_blank');
    if (win) win.opener = null;
    const { data, error } = await state.sb.storage.from(bucket).createSignedUrl(path, 600);
    if (error) { if (win) win.close(); toast(friendlyError(error), true); return; }
    if (win) win.location.href = data.signedUrl; else location.href = data.signedUrl;
  }

  function filesPart(p) {
    const files = filesOf(p.id);
    const input = h('input', { type: 'file', accept: '.pdf,application/pdf', 'aria-label': 'Upload the PDF of this paper' });
    const status = h('span', { class: 'small muted', role: 'status' });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      if (!/\.pdf$/i.test(f.name)) { toast('Please choose a PDF file.', true); return; }
      if (f.size > MAX_FILE) { toast('Files can be up to 50 MB.', true); return; }
      input.disabled = true;
      status.textContent = `Uploading ${f.name}…`;
      const safeName = f.name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(-80);
      const path = `${p.id}/${uid()}/${Date.now()}-${safeName}`;
      const up = await state.sb.storage.from('papers').upload(path, f, { contentType: 'application/pdf', upsert: false });
      if (up.error) { input.disabled = false; status.textContent = ''; toast(friendlyError(up.error), true); return; }
      const { error } = await state.sb.from('paper_files').insert({ paper_id: p.id, storage_path: path, file_name: f.name, size_bytes: f.size, uploaded_by: uid() });
      if (error) {
        await state.sb.storage.from('papers').remove([path]);
        input.disabled = false;
        status.textContent = '';
        toast(friendlyError(error), true);
        return;
      }
      await loadTable('paper_files');
      toast('PDF shared with the other readers.');
      rerender();
    });
    return h('section', { class: 'stack', id: 'dlg-files' },
      h('h3', {}, 'Full text shared by readers'),
      files.length ? h('ul', { class: 'list-plain' }, files.map((f) => h('li', { class: 'row' },
        h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => openStored('papers', f.storage_path) }, `Open ${f.file_name}`),
        h('span', { class: 'small muted' }, `${fileSize(f.size_bytes || 0)} · shared by ${f.uploaded_by === uid() ? 'you' : readerName(f.uploaded_by)}`),
        f.uploaded_by === uid() ? h('button', {
          class: 'btn btn-quiet btn-small', type: 'button',
          onclick: async () => {
            if (!confirm('Remove this PDF for everyone?')) return;
            const { data, error } = await state.sb.from('paper_files').delete().eq('id', f.id).select('id');
            if (error || !data.length) { toast(error ? friendlyError(error) : 'Could not remove it.', true); return; }
            await state.sb.storage.from('papers').remove([f.storage_path]);
            await loadTable('paper_files');
            toast('PDF removed.');
            rerender();
          },
        }, 'Remove') : null)))
        : h('p', { class: 'small muted' }, p.is_oa ? 'None needed so far: this paper is free to read online.' : 'No PDF shared yet. If you have access, upload it so the other readers (and the AI drafting) can use the full text.'),
      h('div', { class: 'row' }, h('label', { class: 'small' }, 'Upload the PDF: ', input), status),
      h('p', { class: 'small muted' }, 'Shared PDFs can be opened by everyone signed in to the tracker.'));
  }

  /* ---------- paper dialog ---------- */

  function openPaper(pid) {
    state.openPaperId = pid;
    renderDialog();
    if (!dialog.open) dialog.showModal();
  }

  function claimControls(p) {
    const mine = myClaim(p.id);
    if (mine) {
      return h('div', { class: 'row' },
        h('label', { for: 'my-status' }, 'Your status'),
        h('select', { id: 'my-status', style: 'width:auto', onchange: (e) => setStatus(p.id, e.target.value) },
          Object.entries(STATUS_LABEL).map(([v, t]) => h('option', { value: v, selected: mine.status === v }, t))),
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => unclaim(p.id) }, 'Give up this paper'));
    }
    if (claimsFor(p.id).length < need(p)) {
      return h('button', { class: 'btn', type: 'button', onclick: (e) => { e.target.disabled = true; claim(p.id); } }, 'Claim this paper');
    }
    return h('p', { class: 'muted small' }, 'All reader slots are taken. You can still add a note below.');
  }

  function noteForm(p) {
    const n = myNote(p.id) || {};
    const field = (key, label, hint, full, rows) => {
      const id = `n-${key}`;
      return h('div', { class: 'field' + (full ? ' full' : '') },
        h('label', { for: id }, label),
        h('textarea', { id, name: key, rows: rows || 3, value: n[key] || '' }),
        hint ? h('span', { class: 'hint' }, hint) : null);
    };
    const sectionSel = h('select', { id: 'n-chapter_section', name: 'chapter_section' },
      h('option', { value: '' }, `Keep in §${p.section}`),
      Object.entries(SECTIONS).map(([s, t]) => h('option', { value: s, selected: String(n.chapter_section || '') === s }, `§${s} ${t}`)));
    const tagSel = h('select', { id: 'n-suggested_tag', name: 'suggested_tag' },
      h('option', { value: '' }, `Keep as ${TAGS[p.tag].label.toLowerCase()}`),
      Object.entries(TAGS).map(([t, info]) => h('option', { value: t, selected: n.suggested_tag === t }, info.label)));
    const verified = h('input', { type: 'checkbox', id: 'n-numbers_verified', name: 'numbers_verified', checked: n.numbers_verified });

    const save = async (markDone) => {
      const form = document.getElementById('note-form');
      const data = new FormData(form);
      const row = { paper_id: p.id, user_id: uid() };
      for (const [key] of NOTE_FIELDS) row[key] = (data.get(key) || '').trim() || null;
      row.numbers_verified = verified.checked;
      row.chapter_section = data.get('chapter_section') ? Number(data.get('chapter_section')) : null;
      row.suggested_tag = data.get('suggested_tag') || null;
      const { error } = await state.sb.from('notes').upsert(row);
      if (error) { toast(friendlyError(error), true); return; }
      await loadTable('notes');
      if (markDone) {
        if (myClaim(p.id)) await setStatus(p.id, 'done');
        else if (claimsFor(p.id).length < need(p)) await claim(p.id, 'done');
      }
      toast(markDone ? 'Note saved and marked as done.' : 'Note saved.');
      rerender();
    };

    return h('form', { id: 'note-form', class: 'note-form', onsubmit: (e) => { e.preventDefault(); save(false); } },
      field('key_finding', 'Key finding', 'Two or three sentences: what did they find?', true, 3),
      field('design_sample', 'Design and sample', 'e.g. RCT, n = 71, 12 weeks, 22 sites'),
      field('key_numbers', 'Key numbers, with page numbers', 'Effect sizes, CIs, AUROCs, as reported in the paper'),
      h('label', { class: 'check full' }, verified,
        h('span', {}, 'I checked these numbers against the full text', p.check_notes && p.check_notes.length ? h('span', { class: 'muted small' }, ' (this paper is on the check-before-citing list)') : null)),
      field('limitations', 'Limitations and caveats', null, false),
      field('quotable', 'Quotable lines (with page)', null, false),
      field('chapter_use', 'How to use it in the chapter', 'Which argument does it support or challenge?', true),
      h('div', { class: 'field' }, h('label', { for: 'n-chapter_section' }, 'Best chapter section'), sectionSel),
      h('div', { class: 'field' }, h('label', { for: 'n-suggested_tag' }, 'Ranking suggestion'), tagSel),
      h('div', { class: 'row full' },
        h('button', { class: 'btn', type: 'submit' }, 'Save note'),
        myClaim(p.id) && myClaim(p.id).status === 'done' ? null
          : h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => save(true) }, 'Save and mark as done'),
        n.updated_at ? h('span', { class: 'muted small' }, `Last saved ${new Date(n.updated_at).toLocaleString()}`) : null));
  }

  function noteCard(n) {
    return h('article', { class: 'note-card' },
      h('div', { class: 'row' },
        h('h3', {}, readerName(n.user_id)),
        h('span', { class: 'muted small' }, new Date(n.updated_at).toLocaleDateString()),
        n.numbers_verified ? h('span', { class: 'badge badge-oa' }, 'Numbers checked') : null),
      h('dl', {}, NOTE_FIELDS.filter(([k]) => n[k]).map(([k, label]) => [h('dt', {}, label), h('dd', {}, n[k])]),
        n.chapter_section ? [h('dt', {}, 'Best section'), h('dd', {}, `§${n.chapter_section} ${SECTIONS[n.chapter_section]}`)] : null,
        n.suggested_tag ? [h('dt', {}, 'Ranking'), h('dd', {}, TAGS[n.suggested_tag].label)] : null));
  }

  function liveParts(p) {
    const others = notesFor(p.id).filter((n) => n.user_id !== uid());
    return [
      h('section', { class: 'stack', id: 'dlg-readers' },
        h('h3', {}, 'Readers'),
        h('div', { class: 'readers', style: 'justify-content:flex-start' }, readerChips(p)),
        claimControls(p)),
      h('section', { class: 'stack', id: 'dlg-others' },
        h('h3', {}, `Other readers' notes (${others.length})`),
        others.length ? others.map(noteCard) : h('p', { class: 'muted small' }, 'None yet.')),
      filesPart(p),
    ];
  }

  function refreshDialogLive() {
    const p = paperById(state.openPaperId);
    const [readers, others, files] = liveParts(p);
    document.getElementById('dlg-readers').replaceWith(readers);
    document.getElementById('dlg-files').replaceWith(files);
    document.getElementById('dlg-others').replaceWith(others);
  }

  function renderDialog() {
    const p = paperById(state.openPaperId);
    const flag = FLAG_TEXT[p.verify_flag];
    const doiUrl = safeHref(p.doi ? `https://doi.org/${p.doi}` : p.url);
    const freeUrl = safeHref(p.oa_url);
    const pdfUrl = safeHref(p.pdf_url);
    const adder = p.added_by ? (p.added_by === uid() ? 'you' : readerName(p.added_by)) : null;
    const [readers, others, files] = liveParts(p);
    dialog.replaceChildren(
      h('div', { class: 'dialog-head' },
        h('div', { class: 'row' }, p.rank ? h('strong', {}, `#${p.rank}`) : null, tagPill(p), accessBadge(p),
          h('span', { class: 'muted small' }, `§${p.section} ${SECTIONS[p.section]}`)),
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => dialog.close() }, 'Close')),
      h('div', { class: 'dialog-body' },
        h('div', { class: 'stack' },
          h('h2', { id: 'dialog-title' }, p.title || shortCite(p)),
          h('p', { class: 'citation' }, p.citation),
          h('div', { class: 'links' },
            doiUrl ? h('a', { href: doiUrl, target: '_blank', rel: 'noopener' }, p.oa_status === 'web' ? 'Official page ↗' : 'Publisher page ↗') : null,
            p.is_oa && freeUrl && freeUrl !== doiUrl ? h('a', { href: freeUrl, target: '_blank', rel: 'noopener' }, 'Free full text ↗') : null,
            pdfUrl ? h('a', { href: pdfUrl, target: '_blank', rel: 'noopener' }, 'PDF ↗') : null),
          adder ? h('div', { class: 'row' },
            h('span', { class: 'muted small' }, `Added by ${adder} on ${new Date(p.created_at).toLocaleDateString()}`),
            p.added_by === uid() ? [
              h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => editPaper(p.id) }, 'Edit'),
              h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => removePaper(p) }, 'Remove'),
            ] : null) : null,
          !p.is_oa ? h('p', { class: 'muted small' }, 'Paywalled: open it through your library access, or use a PDF another reader has shared below.') : null),
        p.why_read ? h('div', { class: 'callout callout-info' }, h('strong', {}, 'Why read it: '), p.why_read) : null,
        flag || (p.check_notes && p.check_notes.length) ? h('div', { class: 'callout' },
          flag ? h('p', {}, h('strong', {}, `${flag[0]}: `), flag[1]) : null,
          p.check_notes && p.check_notes.length ? [h('strong', {}, 'Check before citing'), h('ul', {}, p.check_notes.map((c) => h('li', {}, c)))] : null) : null,
        draftPart(p),
        readers,
        files,
        h('section', { class: 'stack' }, h('h3', {}, 'Your note'), noteForm(p)),
        others));
  }

  dialog.addEventListener('close', () => { state.openPaperId = null; });

  /* ---------- export ---------- */

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const a = h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  function exportMarkdown() {
    const lines = [`# Reading notes — ${today()}`, ''];
    for (const s of Object.keys(SECTIONS).map(Number)) {
      const papers = state.papers.filter((p) => p.section === s && notesFor(p.id).length);
      if (!papers.length) continue;
      lines.push(`## §${s} ${SECTIONS[s]}`, '');
      for (const p of papers) {
        const origin = p.added_by ? ` · added by ${readerName(p.added_by)}` : '';
        lines.push(`### ${shortCite(p)} — ${p.title || ''}`, `${p.rank ? `#${p.rank} · ` : ''}${TAGS[p.tag].label}${origin} · ${p.doi ? 'https://doi.org/' + p.doi : p.url || ''}`, '');
        for (const n of notesFor(p.id)) {
          lines.push(`**${readerName(n.user_id)}**${n.numbers_verified ? ' (numbers checked against full text)' : ''}`);
          for (const [k, label] of NOTE_FIELDS) if (n[k]) lines.push(`- ${label}: ${n[k].replace(/\s*\n\s*/g, ' ')}`);
          if (n.chapter_section && n.chapter_section !== p.section) lines.push(`- Suggested for §${n.chapter_section}`);
          if (n.suggested_tag && n.suggested_tag !== p.tag) lines.push(`- Suggested ranking: ${TAGS[n.suggested_tag].label}`);
          lines.push('');
        }
      }
    }
    download(`reading-notes-${today()}.md`, lines.join('\n'), 'text/markdown');
  }

  function exportCsv() {
    const cols = ['rank', 'tag', 'section', 'short_cite', 'title', 'doi', 'reader', 'status', 'numbers_verified',
      ...NOTE_FIELDS.map(([k]) => k), 'chapter_section', 'suggested_tag', 'updated_at'];
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = state.notes.map((n) => {
      const p = paperById(n.paper_id) || {};
      const c = state.claims.find((x) => x.paper_id === n.paper_id && x.user_id === n.user_id);
      const rec = { ...n, rank: p.rank, tag: p.tag, section: p.section, short_cite: p.short_cite, title: p.title,
        doi: p.doi, reader: readerName(n.user_id), status: c ? c.status : 'not claimed' };
      return cols.map((k) => esc(rec[k])).join(',');
    });
    download(`reading-notes-${today()}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
  }

  /* ---------- routing and startup ---------- */

  const VIEWS = {
    overview: renderOverview, papers: renderPapers, mine: renderMine, add: renderAdd, suggest: renderAdd,
    materials: renderMaterials, profile: () => renderProfile(true), chapter: renderChapter,
  };

  // On live updates these views refresh their lists only, so nobody loses what they are typing
  const LIVE_REDRAW = {
    papers: () => drawList(), materials: () => drawMaterials(), add: () => {}, suggest: () => {}, profile: () => {},
    chapter: (section, sub) => { if (!(state.editing && state.editing.section === Number(section) && !sub)) renderChapter(section, sub); },
  };

  function route(live) {
    if (!state.session || !state.me) return;
    const view = currentView();
    const [name, ...args] = view.split('/');
    if (live === true && app.dataset.view === view && LIVE_REDRAW[name]) { LIVE_REDRAW[name](...args); return; }
    const render = VIEWS[name] || renderOverview;
    if (name !== 'add') state.editPaperId = null;
    document.querySelectorAll('#nav a').forEach((a) => {
      if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const y = window.scrollY;
    render(...args);
    if (live === true) window.scrollTo(0, y);
  }

  function showChrome() {
    const signedIn = Boolean(state.session && state.me);
    document.getElementById('nav').hidden = !signedIn;
    document.getElementById('account').hidden = !state.session;
    document.getElementById('me-link').textContent = state.me ? state.me.display_name : '';
  }

  async function boot() {
    showChrome();
    if (!state.session) { renderSignIn(); return; }
    try {
      await loadAll();
    } catch (err) {
      mount(h('div', { class: 'card card-narrow stack' }, h('h1', {}, 'Could not load the tracker'), h('p', {}, friendlyError(err)),
        h('button', { class: 'btn', type: 'button', onclick: boot }, 'Try again')));
      return;
    }
    showChrome();
    if (!state.me) { renderProfile(false); return; }
    subscribe();
    route();
  }

  async function init() {
    if (!cfg || !cfg.supabaseUrl || !window.supabase) { renderSetup(); return; }
    state.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    document.getElementById('sign-out').addEventListener('click', async () => {
      await state.sb.auth.signOut();
    });
    window.addEventListener('hashchange', () => route());
    // Catch up on anything missed while the tab was in the background or the connection dropped
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !state.session || !state.me) return;
      try {
        await Promise.all(TABLES.map(loadTable));
        rerender();
      } catch (err) { /* offline: keep showing what we have */ }
    });
    const { data } = await state.sb.auth.getSession();
    state.session = data.session;
    state.sb.auth.onAuthStateChange((event, session) => {
      const changed = (session && session.user.id) !== (state.session && state.session.user.id);
      state.session = session;
      if (changed) {
        if (state.channel) { state.sb.removeChannel(state.channel); state.channel = null; }
        state.me = null;
        if (dialog.open) dialog.close();
        setTimeout(boot, 0); // never await Supabase calls inside this callback
      }
    });
    if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + '#/overview');
    boot();
  }

  init();
})();
