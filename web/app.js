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

  const TABLES = ['papers', 'claims', 'notes', 'readers', 'materials'];

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
        h('div', { class: 'paper-badges' }, tagPill(p), accessBadge(p), flagBadges(p))),
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
        select('f-access', 'Access', [['', 'Any access'], ['oa', 'Free full text'], ['closed', 'Paywalled']], 'access')),
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
    mount(h('div', { class: 'stack-lg' },
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

  async function openMaterial(m) {
    // Open the tab straight away (pop-up blockers stop tabs opened after a wait), then send it to a short-lived link
    const win = window.open('', '_blank');
    if (win) win.opener = null;
    const { data, error } = await state.sb.storage.from('materials').createSignedUrl(m.storage_path, 600);
    if (error) { if (win) win.close(); toast(friendlyError(error), true); return; }
    if (win) win.location.href = data.signedUrl; else location.href = data.signedUrl;
  }

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
    h('p', { class: 'muted small' }, 'Drafts, figures, notes from a meeting, a useful report. Everyone signed in to the tracker can open it. Please don\'t upload publisher PDFs of paywalled papers.'),
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
    ];
  }

  function refreshDialogLive() {
    const p = paperById(state.openPaperId);
    const [readers, others] = liveParts(p);
    document.getElementById('dlg-readers').replaceWith(readers);
    document.getElementById('dlg-others').replaceWith(others);
  }

  function renderDialog() {
    const p = paperById(state.openPaperId);
    const flag = FLAG_TEXT[p.verify_flag];
    const doiUrl = safeHref(p.doi ? `https://doi.org/${p.doi}` : p.url);
    const freeUrl = safeHref(p.oa_url);
    const pdfUrl = safeHref(p.pdf_url);
    const adder = p.added_by ? (p.added_by === uid() ? 'you' : readerName(p.added_by)) : null;
    const [readers, others] = liveParts(p);
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
          !p.is_oa ? h('p', { class: 'muted small' }, 'Paywalled: open it through your own library or institutional access. Please don\'t share PDFs of paywalled papers here.') : null),
        p.why_read ? h('div', { class: 'callout callout-info' }, h('strong', {}, 'Why read it: '), p.why_read) : null,
        flag || (p.check_notes && p.check_notes.length) ? h('div', { class: 'callout' },
          flag ? h('p', {}, h('strong', {}, `${flag[0]}: `), flag[1]) : null,
          p.check_notes && p.check_notes.length ? [h('strong', {}, 'Check before citing'), h('ul', {}, p.check_notes.map((c) => h('li', {}, c)))] : null) : null,
        readers,
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
    materials: renderMaterials, profile: () => renderProfile(true),
  };

  // On live updates these views refresh their lists only, so nobody loses what they are typing
  const LIVE_REDRAW = { papers: () => drawList(), materials: () => drawMaterials(), add: () => {}, suggest: () => {}, profile: () => {} };

  function route(live) {
    if (!state.session || !state.me) return;
    const view = currentView();
    if (live === true && app.dataset.view === view && LIVE_REDRAW[view]) { LIVE_REDRAW[view](); return; }
    const render = VIEWS[view] || renderOverview;
    if (view !== 'add') state.editPaperId = null;
    document.querySelectorAll('#nav a').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const y = window.scrollY;
    render();
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
