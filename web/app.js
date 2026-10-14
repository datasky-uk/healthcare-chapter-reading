/* Chapter reading tracker: shared claims and structured notes on the chapter's literature. */
(function () {
  'use strict';

  const cfg = window.TRACKER_CONFIG;
  const app = document.getElementById('app');
  const dialog = document.getElementById('paper-dialog');

  const SECTIONS = {
    1: 'Introduction', 2: 'Technological foundations', 3: 'Diagnostics',
    4: 'Decision support, workflow and operations', 5: 'Biomedical research and drug discovery',
    6: 'AI and the expanding literature', 7: 'Emerging models of evidence synthesis',
    8: 'Bias, safety and governance', 9: 'Future directions',
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
    papers: [], claims: [], notes: [], readers: [], suggestions: [],
    filters: { q: '', section: '', tag: 'ranked', status: '', access: '' },
    openPaperId: null, channel: null,
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

  function mount(...nodes) {
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
    if (/duplicate key/i.test(msg)) return 'You have already claimed this paper.';
    if (/JWT|session/i.test(msg)) return 'Your session expired. Please sign in again.';
    if (/after \d+ seconds/i.test(msg)) return 'A link was sent to this address moments ago. Please wait a minute and try again.';
    if (/rate limit/i.test(msg)) return 'Too many sign-in emails have been sent recently. Please try again later.';
    return msg;
  }

  /* ---------- data ---------- */

  async function loadTable(table) {
    const { data, error } = await state.sb.from(table).select('*');
    if (error) throw error;
    state[table] = data;
  }

  async function loadAll() {
    await Promise.all(['papers', 'claims', 'notes', 'readers', 'suggestions'].map(loadTable));
    state.papers.sort((a, b) => (a.rank || 999) - (b.rank || 999) || a.section - b.section
      || shortCite(a).localeCompare(shortCite(b)));
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
    for (const table of ['claims', 'notes', 'readers', 'suggestions']) {
      state.channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
    }
    state.channel.subscribe();
  }

  function rerender() {
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
        h('span', { class: 'small' }, p.rank ? `§${p.section}` : 'ref')),
      h('div', {},
        h('button', { class: 'paper-title', type: 'button', onclick: () => openPaper(p.id) }, p.title || shortCite(p)),
        h('p', { class: 'paper-meta' }, `${shortCite(p)} · ${SECTIONS[p.section]}`),
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
      if (f.tag && f.tag !== 'ranked' && p.tag !== f.tag) return false;
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
      h('div', { class: 'section-head' }, h('h1', {}, 'Papers'), countHost),
      h('div', { class: 'filters' },
        h('div', { class: 'search' }, search),
        select('f-section', 'Chapter section', [['', 'All sections'], ...Object.entries(SECTIONS).filter(([s]) => state.papers.some((p) => String(p.section) === s)).map(([s, t]) => [s, `§${s} ${t}`])], 'section'),
        select('f-tag', 'Tag', [['ranked', 'Ranked (53)'], ['', 'All 204'], ['essential', 'Essential read'], ['should', 'Should read'], ['mildly', 'Mildly interesting'], ['reference', 'Other references']], 'tag'),
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

  function renderSuggest() {
    const citation = h('textarea', { id: 's-citation', required: true, placeholder: 'Authors (year). Title. Journal.' });
    const doi = h('input', { type: 'text', id: 's-doi', placeholder: '10.xxxx/…' });
    const section = h('select', { id: 's-section' }, h('option', { value: '' }, 'Not sure'),
      Object.entries(SECTIONS).map(([s, t]) => h('option', { value: s }, `§${s} ${t}`)));
    const why = h('textarea', { id: 's-why', placeholder: 'What does it add?' });
    const form = h('form', {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const { error } = await state.sb.from('suggestions').insert({
          user_id: uid(), citation: citation.value.trim(), doi: doi.value.trim() || null,
          section: section.value ? Number(section.value) : null, why: why.value.trim() || null,
        });
        if (error) { toast(friendlyError(error), true); return; }
        await loadTable('suggestions');
        toast('Thanks: suggestion added for review.');
        renderSuggest();
      },
    },
    h('h2', {}, 'Suggest a paper'),
    h('p', { class: 'muted small' }, 'Found something the list is missing? The chapter lead reviews suggestions and adds accepted papers to the tracker.'),
    h('div', { class: 'field' }, h('label', { for: 's-citation' }, 'Citation'), citation),
    h('div', { class: 'row' },
      h('div', { class: 'field', style: 'flex:1;min-width:200px' }, h('label', { for: 's-doi' }, 'DOI (optional)'), doi),
      h('div', { class: 'field', style: 'flex:1;min-width:200px' }, h('label', { for: 's-section' }, 'Chapter section'), section)),
    h('div', { class: 'field' }, h('label', { for: 's-why' }, 'Why it matters'), why),
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Submit suggestion')));
    const list = [...state.suggestions].sort((a, b) => b.created_at.localeCompare(a.created_at));
    mount(h('div', { class: 'stack-lg' }, form,
      h('section', { class: 'stack' },
        h('h2', {}, `Suggestions (${list.length})`),
        list.length ? h('ul', { class: 'list-plain' }, list.map((s) => h('li', { class: 'card stack', style: 'padding:14px 16px;gap:6px' },
          h('div', { class: 'row' },
            h('span', { class: 'badge badge-status' }, s.status === 'open' ? 'Under review' : s.status === 'added' ? 'Added' : 'Not added'),
            s.section ? h('span', { class: 'muted small' }, `§${s.section} ${SECTIONS[s.section]}`) : null,
            h('span', { class: 'muted small' }, `· ${readerName(s.user_id)}`)),
          h('p', {}, s.citation),
          s.doi ? h('a', { href: `https://doi.org/${s.doi}`, target: '_blank', rel: 'noopener' }, `doi:${s.doi}`) : null,
          s.why ? h('p', { class: 'muted small' }, s.why) : null)))
          : h('p', { class: 'empty' }, 'No suggestions yet.'))));
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
    const doiUrl = p.doi ? `https://doi.org/${p.doi}` : p.url;
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
            p.is_oa && p.oa_url && p.oa_url !== doiUrl ? h('a', { href: p.oa_url, target: '_blank', rel: 'noopener' }, 'Free full text ↗') : null,
            p.pdf_url ? h('a', { href: p.pdf_url, target: '_blank', rel: 'noopener' }, 'PDF ↗') : null),
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
        lines.push(`### ${shortCite(p)} — ${p.title || ''}`, `${p.rank ? `#${p.rank} · ` : ''}${TAGS[p.tag].label} · ${p.doi ? 'https://doi.org/' + p.doi : p.url || ''}`, '');
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

  const VIEWS = { overview: renderOverview, papers: renderPapers, mine: renderMine, suggest: renderSuggest, profile: () => renderProfile(true) };

  function route(keepScroll) {
    if (!state.session || !state.me) return;
    const view = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    const render = VIEWS[view] || renderOverview;
    document.querySelectorAll('#nav a').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const y = window.scrollY;
    render();
    if (keepScroll === true) window.scrollTo(0, y);
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
        await Promise.all(['claims', 'notes', 'readers', 'suggestions'].map(loadTable));
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
