/*  Wikisource → Wikidata book editor
 *  ------------------------------------------------------------------
 *  Written and maintained by User:Jameela P. as part of the
 *  Wiki Librarians Network.
 *  ------------------------------------------------------------------
 *  A userscript for www.wikidata.org. Load a CSV/TSV export of
 *  ml.wikisource index pages, then walk through it row by row:
 *  find (or create) the edition item, compare each statement with the
 *  CSV, resolve authors/publishers/places to QIDs, and add what is
 *  missing. One "Add" click = one Wikidata edit.
 *
 *  Install
 *    1. Save this file as  User:<you>/BookEditor.js  on Wikidata.
 *    2. Add to            User:<you>/common.js :
 *       mw.loader.load('//www.wikidata.org/w/index.php?title=User:<you>/BookEditor.js&action=raw&ctype=text/javascript');
 *    3. Open https://www.wikidata.org/wiki/Special:BlankPage/BookEditor
 */
(function () {
  'use strict';

  if (!/Special(:|%3A)BlankPage\/BookEditor/i.test(location.pathname + location.search)) return;

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* ------------------------------------------------------------------ */

  const WS_BASE = 'https://ml.wikisource.org/wiki/';
  const SUMMARY = 'Book data from Wikisource via Wikisource → Wikidata book editor (#mlwsBookEditor)';
  const LS_SESSION = 'mlwsBE.session.v1';
  const LS_CACHE = 'mlwsBE.entityCache.v1';
  const Q_EDITION = 'Q3331189';
  const Q_MALAYALAM = 'Q36236';
  const STRONG = new Set(['CSV QID', 'Wikisource sitelink', 'P1957 index URL', 'P996 file']);

  // key → CSV column (chosen in the mapping panel). helper = used for lookup only.
  const FIELDS = [
    { key: 'qid', label: 'Existing QID column', helper: true, guess: ['wikidata_id', 'qid', 'item'] },
    { key: 'titleUrl', label: 'Work page URL (finds sitelinked item)', helper: true, guess: ['book_title_url'] },
    { key: 'titleRaw', label: 'Title wikitext – [[link]] becomes the mlwikisource sitelink', helper: true, guess: ['book_title_raw'] },
    { key: 'authorUrl', label: 'Author page URL (finds sitelinked author)', helper: true, guess: ['author_url'] },
    { key: 'cover', label: 'Cover thumbnail URL', helper: true, guess: ['cover_thumbnail_url'] },
    { key: 'fileFallback', label: 'File URL (fallback / local-file check)', helper: true, guess: ['source_file_url'] },
    { key: 'index', prop: 'P1957', label: 'Wikisource index page URL', type: 'url', guess: ['index_page_title'] },
    { key: 'title', prop: 'P1476', label: 'title', type: 'mono', ref: true, guess: ['book_title'] },
    { key: 'author', prop: 'P50', label: 'author', type: 'item', split: true, ref: true, newP31: 'Q5', stringProp: 'P2093', guess: ['author'] },
    { key: 'translator', prop: 'P655', label: 'translator', type: 'item', split: true, ref: true, newP31: 'Q5', guess: ['translator'] },
    { key: 'editor', prop: 'P98', label: 'editor', type: 'item', split: true, ref: true, newP31: 'Q5', guess: ['editor'] },
    {
      key: 'publisher', prop: 'P123', label: 'publisher', type: 'item', ref: true, newP31: 'Q2085381',
      newDesc: 'publishing company based in Kerala', newClaims: [['P17', 'Q668']], guess: ['publisher'],
    },
    { key: 'place', prop: 'P291', label: 'place of publication', type: 'item', ref: true, newP31: 'Q486972', guess: ['publication_place'] },
    { key: 'year', prop: 'P577', label: 'publication date', type: 'time', ref: true, guess: ['publication_year'] },
    { key: 'file', prop: 'P996', label: 'document file on Commons', type: 'commons', guess: ['index_page_title'] },
    {
      key: 'pages', prop: 'P1104', label: 'number of pages', type: 'quantity', ref: true, always: true,
      fallbackCols: ['page_count_from_pagelist', 'page_count_from_page_namespace', 'last_scan_page'], guess: ['page_count'],
    },
  ];

  const NEW_P31 = [['', '(no instance of)'], ['Q5', 'human'], ['Q2085381', 'publishing house'], ['Q486972', 'human settlement']];
  const PROP_LABELS = { P17: 'country', P21: 'sex or gender', P2093: 'author name string' };
  const GENDERS = [['', 'not set'], ['Q6581097', 'male'], ['Q6581072', 'female']];

  const DV = { item: 'wikibase-entityid', url: 'string', commons: 'string', string: 'string', mono: 'monolingualtext', time: 'time', quantity: 'quantity' };

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const S = { headers: [], rows: [], map: {}, idx: 0, opts: { refs: true }, cur: null };
  const labels = {
    [Q_EDITION]: { label: 'version, edition or translation', desc: '' },
    [Q_MALAYALAM]: { label: 'Malayalam', desc: '' },
    Q668: { label: 'India', desc: '' },
    Q6581097: { label: 'male', desc: '' },
    Q6581072: { label: 'female', desc: '' },
    Q2085381: { label: 'publishing house', desc: '' },
  };
  let cache = loadJSON(LS_CACHE, {});
  let loadToken = 0;
  let api, commonsApi;

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                     */
  /* ------------------------------------------------------------------ */

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat(Infinity).forEach(c => {
      if (c != null && c !== false && c !== '') el.append(c instanceof Node ? c : String(c));
    });
    return el;
  }

  function loadJSON(key, dflt) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }
  function saveSession() {
    const ok = saveJSON(LS_SESSION, { headers: S.headers, rows: S.rows, map: S.map, idx: S.idx, opts: S.opts });
    if (!ok) showMsg('Could not save progress in browser storage (file too large?). Export regularly.', 'warn');
  }
  const safeDecode = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  const pad = n => String(n).padStart(2, '0');
  const pickLang = o => { if (!o) return ''; const v = o.ml || o.mul || o.en || Object.values(o)[0]; return v ? v.value : ''; };
  const labelOf = id => (labels[id] && labels[id].label) || id;
  const hasMalayalam = s => /[\u0D00-\u0D7F]/.test(s || '');
  const isUnknown = s => !s || /^(unknown|ലഭ്യമല്ല|n\/?a|-|—|\?)$/i.test(s.trim()) || /^അജ്ഞാത/.test(s.trim());

  function cellOf(row, key) {
    const col = S.map[key];
    return col && row ? String(row[col] == null ? '' : row[col]).trim() : '';
  }
  // "[[കേരളോല്പത്തി|KERALOLPATTI …]]" → "കേരളോല്പത്തി"; plain text → null
  function wikilinkTarget(raw) {
    const m = /\[\[\s*:?\s*([^\]|#]+?)\s*(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/.exec(raw || '');
    return m ? m[1].replace(/_/g, ' ').replace(/\s+/g, ' ').trim() : null;
  }
  const normPage = t => String(t || '').replace(/_/g, ' ').trim().replace(/^./, c => c.toUpperCase());
  function wsTitleFromUrl(u) {
    const m = /^https?:\/\/ml\.wikisource\.org\/wiki\/([^?#]+)/.exec(u || '');
    return m ? safeDecode(m[1]).replace(/_/g, ' ') : null;
  }
  function normUrl(u) { return safeDecode(String(u).trim()).replace(/ /g, '_'); }
  function indexUrl(row) {
    const t = cellOf(row, 'index');
    if (!t) return '';
    return /^https?:/.test(t) ? normUrl(t) : WS_BASE + t.replace(/ /g, '_');
  }
  function normFile(f) {
    f = String(f).replace(/^(File|Image|പ്രമാണം|ചിത്രം):/i, '').replace(/_/g, ' ').trim();
    return f.charAt(0).toUpperCase() + f.slice(1);
  }
  function commonsFileFromCell(v) {
    v = (v || '').trim();
    if (!v) return { name: null };
    if (/^https?:\/\//.test(v)) {
      const u = v.split(/[?#]/)[0];
      if (/\/\/commons\.wikimedia\.org\/wiki\//.test(u)) return { name: normFile(safeDecode(u.split('/wiki/')[1])) };
      if (/\/\/upload\.wikimedia\.org\/wikipedia\/commons\//.test(u)) return { name: normFile(safeDecode(u.split('/').pop())) };
      if (/wikisource/.test(u)) return { name: null, local: true };
      return { name: null };
    }
    return { name: normFile(v) };
  }
  function fileFromIndexTitle(t) {
    t = (t || '').trim();
    if (!t) return null;
    if (/^https?:\/\//.test(t)) t = safeDecode(t.split(/[?#]/)[0].split('/wiki/').pop());
    t = t.replace(/^(സൂചിക|Index)\s*:\s*/i, '');
    return t ? normFile(t) : null;
  }
  function splitParts(raw, split) {
    const parts = split ? raw.split(/\s*[&;]\s*/) : [raw];
    return parts.map(s => s.trim()).filter(Boolean);
  }
  const cleanName = s => s.replace(/^(pub|publisher|ed|by)\s*[:.]\s*/i, '').replace(/[.,;:]+$/, '').trim();

  const itemValue = qid => ({ 'entity-type': 'item', 'numeric-id': Number(qid.slice(1)), id: qid });
  const timeValue = y => ({
    time: `+${String(y).padStart(4, '0')}-00-00T00:00:00Z`, timezone: 0, before: 0, after: 0,
    precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
  });
  function todayValue() {
    const d = new Date();
    return {
      time: `+${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00:00Z`,
      timezone: 0, before: 0, after: 0, precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    };
  }
  const snak = (prop, type, value) => ({ snaktype: 'value', property: prop, datavalue: { type: DV[type], value } });
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().toUpperCase();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    }).toUpperCase();
  }
  const claimIds = (e, p) => ((e && e.claims && e.claims[p]) || [])
    .map(c => c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id).filter(Boolean);
  function firstYear(e, p) {
    const c = ((e.claims || {})[p] || []).find(x => x.mainsnak.datavalue);
    return c ? c.mainsnak.datavalue.value.time.slice(1, 5) : '';
  }

  /* ------------------------------------------------------------------ */
  /* CSV / TSV parsing                                                   */
  /* ------------------------------------------------------------------ */

  function parseCSV(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"' && f === '') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim() !== ''));
  }
  function parseTSV(text) {
    return text.split(/\r?\n/).filter(l => l.trim() !== '').map(l => l.split('\t').map(x =>
      (x.length > 1 && x[0] === '"' && x[x.length - 1] === '"') ? x.slice(1, -1).replace(/""/g, '"') : x));
  }
  function parseTable(text) {
    text = text.replace(/^\uFEFF/, '');
    const first = text.split(/\r?\n/, 1)[0];
    const tabs = (first.match(/\t/g) || []).length, commas = (first.match(/,/g) || []).length;
    const grid = (tabs && tabs >= commas) ? parseTSV(text) : parseCSV(text);
    if (!grid.length) return { headers: [], rows: [] };
    const seen = new Set();
    const headers = grid[0].map((x, i) => {
      let n = x.trim() || `col_${i + 1}`;
      if (seen.has(n)) n = `${n}_${i + 1}`;
      seen.add(n); return n;
    });
    const rows = grid.slice(1).map(cells => {
      const o = {}; headers.forEach((hd, i) => { o[hd] = cells[i] == null ? '' : cells[i]; }); return o;
    });
    return { headers, rows };
  }
  function guessMap(headers) {
    const lower = headers.map(x => x.toLowerCase().trim()), m = {};
    for (const f of FIELDS) {
      for (const g of f.guess) { const i = lower.indexOf(g); if (i >= 0) { m[f.key] = headers[i]; break; } }
    }
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* API helpers                                                         */
  /* ------------------------------------------------------------------ */

  function call(method, params) {
    return new Promise((resolve, reject) => {
      api[method](params).then(resolve, (code, data) => {
        const msg = (data && data.errors && data.errors.map(e => e.text || e.code).join('; ')) ||
          (data && data.error && data.error.info) || code;
        reject(new Error(msg));
      });
    });
  }
  const get = p => call('get', p);
  const post = p => call('postWithEditToken', Object.assign({ assert: 'user', summary: SUMMARY }, p));

  async function getEntities(ids, props) {
    ids = [...new Set(ids.filter(Boolean))];
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const r = await get({
        action: 'wbgetentities', ids: ids.slice(i, i + 50).join('|'),
        props: props || 'labels|descriptions|claims', languages: 'ml|en|mul', languagefallback: 1,
      });
      Object.assign(out, r.entities);
    }
    return out;
  }
  async function fetchLabels(ids) {
    const need = [...new Set(ids)].filter(id => id && /^Q\d+$/.test(id) && !labels[id]);
    if (!need.length) return;
    const ents = await getEntities(need, 'labels|descriptions');
    Object.values(ents).forEach(e => {
      if (e && e.id) labels[e.id] = { label: pickLang(e.labels) || e.id, desc: pickLang(e.descriptions) };
    });
  }
  async function searchItems(text) {
    if (!text) return [];
    const res = new Map();
    const runs = await Promise.allSettled(['ml', 'en'].map(lang => get({
      action: 'wbsearchentities', search: text, language: lang, uselang: 'ml', type: 'item', limit: 7,
    })));
    runs.forEach(r => {
      if (r.status !== 'fulfilled') return;
      (r.value.search || []).forEach(s => {
        if (res.has(s.id)) return;
        const matched = (s.match && s.match.text) || s.label || '';
        res.set(s.id, { id: s.id, label: s.label || s.id, desc: s.description || '', exact: matched.trim() === text.trim() });
      });
    });
    return [...res.values()];
  }
  async function cirrus(q, limit) {
    const r = await get({ action: 'query', list: 'search', srsearch: q, srnamespace: 0, srlimit: limit || 10, srprop: '' });
    return ((r.query && r.query.search) || []).map(s => s.title);
  }
  async function bySitelink(site, title) {
    if (!title) return null;
    const r = await get({ action: 'wbgetentities', sites: site, titles: title, props: 'info' });
    return Object.keys(r.entities || {}).find(k => /^Q\d+$/.test(k)) || null;
  }
  function checkCommons(name) {
    commonsApi = commonsApi || new mw.ForeignApi('https://commons.wikimedia.org/w/api.php', { anonymous: true });
    return new Promise(resolve => {
      commonsApi.get({ action: 'query', titles: 'File:' + name, redirects: 1, formatversion: 2 }).then(r => {
        const p = r.query && r.query.pages && r.query.pages[0];
        resolve(!p || p.missing || p.invalid ? null : normFile(p.title));
      }, () => resolve(undefined));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Statement model                                                     */
  /* ------------------------------------------------------------------ */

  function buildStatements(row) {
    const out = [
      { prop: 'P31', label: 'instance of', type: 'item', csv: '(always)', qid: Q_EDITION, fixed: true },
      { prop: 'P407', label: 'language of work or name', type: 'item', csv: '(always)', qid: Q_MALAYALAM, fixed: true },
    ];
    const rawTitle = cellOf(row, 'titleRaw');
    const linkPage = wikilinkTarget(rawTitle);
    if (linkPage) {
      out.push({ prop: 'mlwikisource', label: 'sitelink (Malayalam Wikisource)', type: 'sitelink', csv: rawTitle, page: linkPage, note: 'checking Wikisource…' });
    }
    for (const f of FIELDS) {
      if (f.helper) continue;
      const raw = cellOf(row, f.key);
      const base = { prop: f.prop, label: f.label, type: f.type, ref: !!f.ref, csv: raw };
      switch (f.type) {
        case 'url':
          if (raw) out.push(Object.assign(base, { value: indexUrl(row) }));
          break;
        case 'mono':
          if (raw) out.push(Object.assign(base, {
            text: raw, lang: 'ml',
            note: hasMalayalam(raw) ? '' : 'Title is not in Malayalam script – check the language code',
          }));
          break;
        case 'item':
          if (!raw) break;
          if (isUnknown(raw)) { out.push(Object.assign(base, { unknown: true })); break; }
          splitParts(raw, f.split).forEach(p => {
            const cached = cache[f.prop + '|' + p];
            const st = Object.assign({}, base, {
              csv: p, part: true, search: cleanName(p), strValue: cleanName(p),
              origProp: f.prop, origLabel: f.label, stringProp: f.stringProp,
              newP31: f.newP31, newDesc: f.newDesc || '', newClaims: f.newClaims || [],
              qid: cached && cached !== '@string' ? cached : null,
              how: cached ? 'remembered from earlier row' : '', candidates: null,
            });
            if (cached === '@string' && f.stringProp) setAsString(st, true);
            out.push(st);
          });
          break;
        case 'time': {
          if (!raw) break;
          const y = (raw.match(/\d{3,4}/) || [])[0] || '';
          out.push(Object.assign(base, { year: y }));
          break;
        }
        case 'commons': {
          // Primary: the index page title minus its namespace (സൂചിക:Foo.pdf → Foo.pdf).
          const name = fileFromIndexTitle(raw);
          const fb = commonsFileFromCell(cellOf(row, 'fileFallback'));
          if (!name && !fb.name && !fb.local) break;
          out.push(Object.assign(base, {
            csv: raw, value: name || fb.name, fileName: name || fb.name,
            altName: fb.name && fb.name !== name ? fb.name : null, local: !!fb.local,
            note: fb.local ? 'File is hosted locally on ml.wikisource, not on Commons – P996 not possible' : 'checking Commons…',
          }));
          if (fb.local) { const st = out[out.length - 1]; st.value = st.fileName = null; }
          break;
        }
        case 'quantity': {
          // Use the mapped column first, then the fallback columns; if all are blank the
          // page count is read from the scanned file when the row loads (resolvePages).
          let n = parseInt(raw, 10), from = raw ? S.map[f.key] : '';
          if (!(n > 0)) {
            for (const col of f.fallbackCols || []) {
              const v = parseInt(String(row[col] == null ? '' : row[col]).trim(), 10);
              if (v > 0) { n = v; from = col; break; }
            }
          }
          if (n > 0 || f.always) {
            out.push(Object.assign(base, {
              n: n > 0 ? n : null, csv: n > 0 ? String(n) : '',
              note: n > 0 ? (from && from !== S.map[f.key] ? `from ${from}` : '') : 'reading page count from the scan…',
            }));
          }
          break;
        }
      }
    }
    return out;
  }

  // Switch an author row between "link to an item" (P50) and "plain name" (P2093).
  function setAsString(st, on) {
    st.asString = !!on;
    if (on) { st.prop = st.stringProp; st.type = 'string'; st.label = PROP_LABELS[st.stringProp]; st.qid = null; }
    else { st.prop = st.origProp; st.type = 'item'; st.label = st.origLabel; }
  }

  function valueOf(st) {
    switch (st.type) {
      case 'string': return st.strValue ? st.strValue.trim() : null;
      case 'item': return st.qid ? itemValue(st.qid) : null;
      case 'url': case 'commons': return st.value || null;
      case 'mono': return st.text ? { text: st.text, language: st.lang || 'ml' } : null;
      case 'time': return /^\d{3,4}$/.test(st.year || '') ? timeValue(st.year) : null;
      case 'quantity': return st.n ? { amount: '+' + st.n, unit: '1' } : null;
    }
    return null;
  }
  function same(type, a, b) {
    switch (type) {
      case 'item': return (a.id || 'Q' + a['numeric-id']) === (b.id || 'Q' + b['numeric-id']);
      case 'url': return normUrl(a) === normUrl(b);
      case 'string': return String(a).trim() === String(b).trim();
      case 'commons': return normFile(a) === normFile(b);
      case 'mono': return a.text.trim() === b.text.trim();
      case 'time': return a.time.slice(1, 5) === b.time.slice(1, 5);
      case 'quantity': return Number(a.amount) === Number(b.amount);
    }
    return false;
  }
  function existing(prop) {
    const cl = (S.cur.entity && S.cur.entity.claims[prop]) || [];
    return cl.map(c => ({ snaktype: c.mainsnak.snaktype, v: c.mainsnak.snaktype === 'value' ? c.mainsnak.datavalue.value : null }));
  }
  function currentSitelink() {
    const e = S.cur.entity, sl = e && e.sitelinks && e.sitelinks.mlwikisource;
    return sl ? sl.title : '';
  }
  function statusOf(st) {
    if (st.unknown) return 'unknown';
    if (st.type === 'sitelink') {
      if (!st.page || st.blocked) return 'nodata';
      if (!S.cur.entity) return 'ready';
      const now = currentSitelink();
      if (!now) return 'missing';
      return normPage(now) === normPage(st.page) ? 'match' : 'differs';
    }
    const v = valueOf(st);
    if (v == null) return st.part ? 'unresolved' : 'nodata';
    if (!S.cur.entity) return 'ready';
    const ex = existing(st.prop);
    if (ex.some(e => e.v && same(st.type, v, e.v))) return 'match';
    return ex.length ? 'differs' : 'missing';
  }
  function plain(type, v) {
    switch (type) {
      case 'item': return v.id;
      case 'mono': return `${v.text} (${v.language})`;
      case 'time': return v.time.slice(1, 5);
      case 'quantity': return v.amount.replace(/^\+/, '');
      default: return String(v);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Lookups for one row                                                 */
  /* ------------------------------------------------------------------ */

  async function findBook(cur) {
    const row = cur.row, found = new Map(), jobs = [];
    const add = (id, m) => {
      if (!/^Q\d+$/.test(id || '')) return;
      if (!found.has(id)) found.set(id, new Set());
      found.get(id).add(m);
    };
    const q = cellOf(row, 'qid').toUpperCase();
    if (/^Q\d+$/.test(q)) add(q, 'CSV QID');

    const wts = new Set([wsTitleFromUrl(cellOf(row, 'titleUrl')), wikilinkTarget(cellOf(row, 'titleRaw'))].filter(Boolean));
    wts.forEach(wt => jobs.push(bySitelink('mlwikisource', wt).then(id => add(id, 'Wikisource sitelink'))));

    if (cur.indexUrl) {
      new Set([cur.indexUrl, cur.indexUrl.replace(/_/g, ' '), encodeURI(cur.indexUrl)]).forEach(v =>
        jobs.push(cirrus(`haswbstatement:"P1957=${v}"`).then(ids => ids.forEach(id => add(id, 'P1957 index URL')))));
    }
    const fileSt = cur.stmts.find(s => s.prop === 'P996');
    if (fileSt && fileSt.fileName) {
      jobs.push(cirrus(`haswbstatement:"P996=${fileSt.fileName}"`).then(ids => ids.forEach(id => add(id, 'P996 file'))));
    }
    const title = cellOf(row, 'title');
    if (title) {
      jobs.push(searchItems(title).then(rs => rs.forEach(r => add(r.id, r.exact ? 'exact label' : 'label search'))));
      jobs.push(cirrus(`${title.replace(/["\\]/g, ' ')} haswbstatement:P407=${Q_MALAYALAM}`, 5)
        .then(ids => ids.forEach(id => add(id, 'full-text search'))));
    }
    await Promise.allSettled(jobs);
    return found;
  }

  async function resolveBook(cur) {
    if (cur.row._qid) { await loadEntity(cur, cur.row._qid); return; }
    const found = await findBook(cur);
    const strong = [...found].filter(([, m]) => [...m].some(x => STRONG.has(x))).map(([id]) => id);
    if (strong.length === 1) {
      await loadEntity(cur, strong[0]);
      cur.autoPicked = [...found.get(strong[0])].filter(x => STRONG.has(x)).join(', ');
    }
    const ids = [...found.keys()].slice(0, 12);
    if (!ids.length) return;
    const ents = await getEntities(ids, 'labels|descriptions|claims');
    const p31s = [];
    cur.candidates = Object.values(ents).filter(e => e && e.id && !('missing' in e)).map(e => {
      const p31 = claimIds(e, 'P31');
      p31s.push(...p31);
      return {
        id: e.id, label: pickLang(e.labels) || e.id, desc: pickLang(e.descriptions), p31,
        year: firstYear(e, 'P577'), isEdition: p31.includes(Q_EDITION),
        methods: [...(found.get(e.id) || ['search'])],
      };
    }).sort((a, b) => score(b) - score(a));
    cur.candidates.forEach(c => { labels[c.id] = labels[c.id] || { label: c.label, desc: c.desc }; });
    await fetchLabels(p31s);
  }
  const score = c => c.methods.reduce((s, m) => s + (STRONG.has(m) ? 10 : m === 'exact label' ? 3 : 1), 0) + (c.isEdition ? 2 : 0);

  // Fill P1104 from the scan's own page count when the file gave none.
  async function resolvePages(cur) {
    const st = cur.stmts.find(s => s.prop === 'P1104');
    if (!st || st.n) return;
    const idx = cellOf(cur.row, 'index');
    const title = /^https?:/.test(idx) ? wsTitleFromUrl(idx) : idx;
    const fileName = (title || '').replace(/^(സൂചിക|Index)\s*:\s*/i, '');
    if (!fileName) { st.note = 'No page count – type it in'; return; }
    try {
      const r = await wsGet({ action: 'query', titles: 'File:' + fileName, prop: 'imageinfo', iiprop: 'size' });
      const p = r.query && r.query.pages && r.query.pages[0];
      const pc = p && p.imageinfo && p.imageinfo[0] && p.imageinfo[0].pagecount;
      if (pc > 0) { st.n = pc; st.csv = String(pc); st.note = 'from the scanned file'; }
      else st.note = 'No page count found – type it in';
    } catch (e) { st.note = 'Could not read the page count – type it in'; }
  }

  async function resolveFile(cur) {
    const st = cur.stmts.find(s => s.prop === 'P996');
    if (!st || !st.fileName) return;
    let res = await checkCommons(st.fileName);
    if (res === null && st.altName) {
      const alt = await checkCommons(st.altName);
      if (alt) {
        st.note = `"${st.fileName}" (from index title) is not on Commons; using the file URL name instead`;
        st.value = st.fileName = alt; return;
      }
    }
    if (res === null) { st.value = null; st.note = `"${st.fileName}" was not found on Commons`; }
    else if (res === undefined) st.note = 'Could not reach Commons – file not verified';
    else {
      st.note = res !== st.fileName ? `Commons redirect → ${res}` : 'Found on Commons';
      st.value = st.fileName = res;
    }
  }

  let wsApi;
  async function resolveSitelink(cur) {
    const st = cur.stmts.find(s => s.type === 'sitelink');
    if (!st) return;
    wsApi = wsApi || new mw.ForeignApi('https://ml.wikisource.org/w/api.php', { anonymous: true });
    const page = await new Promise(resolve => {
      wsApi.get({ action: 'query', titles: st.page, redirects: 1, formatversion: 2 }).then(r => {
        const p = r.query && r.query.pages && r.query.pages[0];
        resolve(!p || p.missing || p.invalid ? null : p.title);
      }, () => resolve(undefined));
    });
    if (page === null) { st.blocked = true; st.note = `"${st.page}" does not exist on ml.wikisource`; return; }
    if (page === undefined) st.note = 'Could not reach Wikisource – page not verified';
    else { st.note = page !== st.page ? `Wikisource redirect → ${page}` : 'Page exists on ml.wikisource'; st.page = page; }
    const owner = await bySitelink('mlwikisource', st.page).catch(() => null);
    st.owner = owner || null;
  }

  async function setSitelink(cur, st) {
    if (!cur.entity || !st.page) return;
    if (st.owner && st.owner !== cur.entity.id) {
      throw new Error(`"${st.page}" is already linked from ${st.owner}. Remove it there first (or merge the items).`);
    }
    const id = cur.entity.id;
    const r = await post({ action: 'wbsetsitelink', id, linksite: 'mlwikisource', linktitle: st.page });
    const sl = r.entity && r.entity.sitelinks && r.entity.sitelinks.mlwikisource;
    cur.entity.sitelinks.mlwikisource = sl || { site: 'mlwikisource', title: st.page };
    st.owner = id;
    log(`${id}: Added link to [mlwikisource]: ${cur.entity.sitelinks.mlwikisource.title}`, r.entity && r.entity.lastrevid);
  }

  async function resolveParts(cur) {
    const parts = cur.stmts.filter(s => s.part);
    const authorTitle = wsTitleFromUrl(cellOf(cur.row, 'authorUrl'));
    const authors = parts.filter(p => p.origProp === 'P50');
    await Promise.all(parts.map(async st => {
      if (st.origProp === 'P50' && authorTitle && !st.qid && !st.asString && authors.length === 1) {
        try {
          const id = await bySitelink('mlwikisource', authorTitle);
          if (id) { st.qid = id; st.how = 'from Wikisource author page sitelink'; remember(st); }
        } catch (e) { /* ignore */ }
      }
      await searchPart(st);
    }));
    await fetchLabels(parts.map(p => p.qid));
  }

  async function searchPart(st) {
    st.candidates = await searchItems(st.search);
    st.candidates.forEach(c => { labels[c.id] = labels[c.id] || { label: c.label, desc: c.desc }; });
    if (!st.qid && !st.asString) {
      const ex = st.candidates.filter(c => c.exact);
      if (ex.length === 1) { st.qid = ex[0].id; st.how = 'single exact label match – please check'; }
    }
  }

  function remember(st) {
    const key = (st.origProp || st.prop) + '|' + st.csv;
    if (st.asString) cache[key] = '@string';
    else if (st.qid) cache[key] = st.qid;
    else delete cache[key];
    saveJSON(LS_CACHE, cache);
  }

  async function loadEntity(cur, id) {
    const ents = await getEntities([id], 'labels|descriptions|claims|sitelinks');
    const e = Object.values(ents).find(x => x && x.id);
    if (!e || 'missing' in e) throw new Error(`${id} does not exist`);
    if (!e.claims || Array.isArray(e.claims)) e.claims = {};
    if (!e.sitelinks || Array.isArray(e.sitelinks)) e.sitelinks = {};
    cur.entity = e;
    cur.row._qid = e.id;
    labels[e.id] = { label: pickLang(e.labels) || e.id, desc: pickLang(e.descriptions) };
    const ids = [];
    ['P31', 'P407', 'P50', 'P655', 'P98', 'P123', 'P291', 'P629'].forEach(p => ids.push(...claimIds(e, p)));
    await fetchLabels(ids);
    saveSession();
  }

  /* ------------------------------------------------------------------ */
  /* Edits                                                               */
  /* ------------------------------------------------------------------ */

  async function addStatement(cur, st) {
    if (st.type === 'sitelink') return setSitelink(cur, st);
    const v = valueOf(st);
    if (!v || !cur.entity) return;
    const id = cur.entity.id;
    const claim = { id: `${id}$${uuid()}`, type: 'statement', rank: 'normal', mainsnak: snak(st.prop, st.type, v) };
    if (S.opts.refs && st.ref && cur.indexUrl) {
      claim.references = [{
        snaks: { P854: [snak('P854', 'url', cur.indexUrl)], P813: [snak('P813', 'time', todayValue())] },
        'snaks-order': ['P854', 'P813'],
      }];
    }
    const r = await post({ action: 'wbsetclaim', claim: JSON.stringify(claim) });
    (cur.entity.claims[st.prop] = cur.entity.claims[st.prop] || []).push(r.claim || claim);
    log(`${id}: added ${st.prop} = ${plain(st.type, v)}`, r.pageinfo && r.pageinfo.lastrevid);
  }

  // claims: list of [property, QID] pairs, e.g. [['P31','Q2085381'], ['P17','Q668']]
  async function createItem(labelText, labelLang, descs, claims) {
    const data = { labels: { [labelLang]: { language: labelLang, value: labelText } } };
    const d = {};
    Object.entries(descs || {}).forEach(([lang, val]) => { if (val && val.trim()) d[lang] = { language: lang, value: val.trim() }; });
    if (Object.keys(d).length) data.descriptions = d;
    const cl = (claims || []).filter(([p, q]) => p && /^Q\d+$/.test(q || ''));
    if (cl.length) data.claims = cl.map(([p, q]) => ({ mainsnak: snak(p, 'item', itemValue(q)), type: 'statement', rank: 'normal' }));
    const r = await post({ action: 'wbeditentity', new: 'item', data: JSON.stringify(data) });
    const id = r.entity.id;
    labels[id] = { label: labelText, desc: '' };
    log(`created ${id} "${labelText}"`, r.entity.lastrevid);
    return id;
  }

  async function withBusy(fn) {
    const cur = S.cur;
    cur.busy = true; renderRow();
    try { await fn(cur); } catch (e) { showMsg(e.message, 'error'); }
    cur.busy = false;
    if (cur === S.cur) { renderNav(); renderRow(); }
  }

  const doAdd = st => withBusy(cur => addStatement(cur, st));
  const addAllMissing = () => withBusy(async cur => {
    for (const st of cur.stmts) if (statusOf(st) === 'missing') await addStatement(cur, st);
  });

  /* ------------------------------------------------------------------ */
  /* Row loading & navigation                                            */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* Fill blank cells from the Wikisource index page                     */
  /* ------------------------------------------------------------------ */

  // Columns the reader writes into when the file left them empty.
  const ENRICH_COLS = {
    title: 'book_title', titleRaw: 'book_title_raw', author: 'author', authorUrl: 'author_url',
    translator: 'translator', editor: 'editor', publisher: 'publisher', place: 'publication_place',
    year: 'publication_year', pages: 'page_count', fileFallback: 'source_file_url',
  };
  // Index template parameter → our field key.
  const INDEX_PARAMS = {
    title: 'title', author: 'author', translator: 'translator', editor: 'editor',
    publisher: 'publisher', address: 'place', year: 'year',
  };

  function getWsApi() {
    wsApi = wsApi || new mw.ForeignApi('https://ml.wikisource.org/w/api.php', { anonymous: true });
    return wsApi;
  }
  const wsGet = params => new Promise((resolve, reject) => {
    getWsApi().get(Object.assign({ formatversion: 2 }, params)).then(resolve, (code, data) =>
      reject(new Error((data && data.error && data.error.info) || code)));
  });

  // Split the {{:MediaWiki:Proofreadpage_index_template |…}} call into named parameters.
  function parseIndexTemplate(wt) {
    const start = wt.search(/\{\{\s*:?\s*MediaWiki:Proofreadpage[_ ]index[_ ]template/i);
    if (start < 0) return null;
    const parts = []; let cur = '', braces = 0, links = 0;
    for (let i = start; i < wt.length; i++) {
      const two = wt.substr(i, 2);
      if (two === '{{') { braces++; i++; if (braces > 1) cur += two; continue; }
      if (two === '}}') { braces--; i++; if (braces === 0) { parts.push(cur); break; } cur += two; continue; }
      if (two === '[[') { links++; i++; cur += two; continue; }
      if (two === ']]') { links = Math.max(0, links - 1); i++; cur += two; continue; }
      if (wt[i] === '|' && braces === 1 && links === 0) { parts.push(cur); cur = ''; continue; }
      cur += wt[i];
    }
    const out = {};
    parts.slice(1).forEach(part => {
      const eq = part.indexOf('=');
      if (eq > 0) out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
    });
    return out;
  }
  function stripWiki(v) {
    return String(v || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<ref[\s\S]*?(<\/ref>|\/>)/gi, '')
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
      .replace(/\[\[([^\]]*)\]\]/g, '$1')
      .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/'{2,}/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  async function enrichRow(row) {
    const idx = cellOf(row, 'index') || '';
    const title = /^https?:/.test(idx) ? wsTitleFromUrl(idx) : idx;
    if (!title) return false;
    const r = await wsGet({ action: 'query', titles: title, prop: 'revisions', rvprop: 'content', rvslots: 'main' });
    const page = r.query && r.query.pages && r.query.pages[0];
    if (!page || page.missing) throw new Error(`Index page "${title}" was not found on ml.wikisource`);
    const params = parseIndexTemplate(page.revisions[0].slots.main.content) || {};
    const fill = (key, val) => {
      val = (val || '').trim();
      if (!val) return;
      const col = S.map[key] || ENRICH_COLS[key];
      if (!S.headers.includes(col)) S.headers.push(col);
      if (!S.map[key]) S.map[key] = col;
      if (!String(row[col] || '').trim()) row[col] = val;
    };
    Object.entries(INDEX_PARAMS).forEach(([param, key]) => fill(key, stripWiki(params[param])));
    if (/\[\[/.test(params.title || '')) fill('titleRaw', params.title);
    const authorLink = /\[\[\s*:?\s*((?:രചയിതാവ്|Author)\s*:[^\]|#]+)/i.exec(params.author || '');
    if (authorLink) fill('authorUrl', WS_BASE + authorLink[1].trim().replace(/ /g, '_'));

    // Page count and real file location (Commons or local) from the scanned file.
    const fileName = title.replace(/^(സൂചിക|Index)\s*:\s*/i, '');
    try {
      const fr = await wsGet({ action: 'query', titles: 'File:' + fileName, prop: 'imageinfo', iiprop: 'size|url' });
      const fp = fr.query && fr.query.pages && fr.query.pages[0];
      const ii = fp && fp.imageinfo && fp.imageinfo[0];
      if (ii) {
        if (ii.pagecount) fill('pages', String(ii.pagecount));
        if (ii.url) fill('fileFallback', ii.url);
      }
    } catch (e) { /* page count stays blank */ }
    return true;
  }
  const needsEnrich = row => !row._enriched && !!cellOf(row, 'index') &&
    !['title', 'author', 'publisher', 'year'].some(k => cellOf(row, k));

  async function loadRow(i) {
    if (i < 0 || i >= S.rows.length) return;
    const token = ++loadToken;
    S.idx = i; saveSession(); renderNav();
    const row = S.rows[i];
    if (needsEnrich(row)) {
      document.getElementById('wsbe-row').replaceChildren(h('div', { class: 'wsbe-card wsbe-muted' }, 'Reading the index page on ml.wikisource…'));
      try { await enrichRow(row); row._enriched = true; saveSession(); renderMapping(); }
      catch (e) { row._enrichErr = 'Could not read the index page: ' + e.message; }
      if (token !== loadToken) return;
    }
    const year = (cellOf(row, 'year').match(/\d{3,4}/) || [])[0] || '';
    const title = cellOf(row, 'title');
    const cur = S.cur = {
      row, entity: null, candidates: [], stmts: buildStatements(row), indexUrl: indexUrl(row),
      workQid: null, loading: true, busy: false, autoPicked: '',
      newForm: {
        label: title, lang: 'ml',
        ml: year ? `${year}-ൽ പ്രസിദ്ധീകരിച്ച പതിപ്പ്` : '',
        en: year ? `${year} Malayalam edition` : '',
      },
    };
    showMsg(row._enrichErr || '', 'warn'); delete row._enrichErr; renderRow();
    const results = await Promise.allSettled([resolveFile(cur), resolvePages(cur), resolveSitelink(cur), resolveParts(cur), resolveBook(cur)]);
    if (token !== loadToken) return;
    const err = results.find(r => r.status === 'rejected');
    if (err) showMsg(err.reason.message, 'error');
    cur.loading = false;
    renderNav(); renderRow();
  }

  function markDoneNext() {
    S.rows[S.idx]._done = true;
    let n = S.rows.findIndex((r, i) => i > S.idx && !r._done);
    if (n < 0) n = Math.min(S.idx + 1, S.rows.length - 1);
    saveSession(); loadRow(n);
  }

  function readFile(file) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const { headers, rows } = parseTable(fr.result);
      if (!rows.length) { showMsg('No data rows found in that file.', 'error'); return; }
      Object.assign(S, { headers, rows, map: guessMap(headers), idx: 0 });
      saveSession(); renderAll(); loadRow(0);
    };
    fr.readAsText(file, 'UTF-8');
  }

  function exportTSV() {
    if (!S.rows.length) return;
    const qcol = S.map.qid || 'wikidata_id';
    const hd = [...S.headers];
    if (!hd.includes(qcol)) hd.push(qcol);
    if (!hd.includes('editor_status')) hd.push('editor_status');
    const lines = [hd.join('\t')].concat(S.rows.map(r => hd.map(k => {
      const v = k === qcol ? (r._qid || r[k] || '') : k === 'editor_status' ? (r._done ? 'done' : '') : (r[k] == null ? '' : r[k]);
      return String(v).replace(/[\t\r\n]+/g, ' ');
    }).join('\t')));
    const blob = new Blob([lines.join('\n')], { type: 'text/tab-separated-values;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'mlws-books-with-qids.tsv' });
    document.body.append(a); a.click(); a.remove();
  }

  function clearSession() {
    if (!confirm('Forget the loaded file and progress? (Remembered author/publisher/place matches are kept.)')) return;
    localStorage.removeItem(LS_SESSION);
    Object.assign(S, { headers: [], rows: [], map: {}, idx: 0, cur: null });
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  const wsLink = t => h('a', { href: WS_BASE + encodeURIComponent(String(t).replace(/ /g, '_')).replace(/%2F/g, '/'), target: '_blank' }, t);
  const propLink = p => h('a', { href: '/wiki/Property:' + p, target: '_blank' }, p);
  // Small button that copies text (e.g. a QID) to the clipboard.
  function copyBtn(text) {
    const btn = h('button', { class: 'wsbe-btn wsbe-copy', type: 'button', title: `Copy ${text}` }, 'Copy ' + text);
    btn.addEventListener('click', async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
        const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
        document.body.append(ta); ta.select();
        try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
        ta.remove();
      }
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy ' + text; }, 1500);
    });
    return btn;
  }
  function qLink(id) {
    const l = labelOf(id);
    return h('span', null, h('a', { href: '/wiki/' + id, target: '_blank' }, l), l !== id ? h('span', { class: 'wsbe-muted' }, ` (${id})`) : null);
  }
  function showMsg(text, kind) {
    const box = document.getElementById('wsbe-msg');
    if (box) box.replaceChildren(text ? h('div', { class: 'wsbe-msg wsbe-msg-' + (kind || 'info') }, text) : '');
  }
  function log(text, rev) {
    const ol = document.getElementById('wsbe-logl');
    ol.prepend(h('li', null, text, rev ? h('span', null, ' ', h('a', { href: '/wiki/Special:Diff/' + rev, target: '_blank' }, 'diff')) : null));
  }

  const STATUS_TEXT = {
    match: 'Already on Wikidata', missing: 'Missing', differs: 'Different value on Wikidata', ready: 'Waiting for book item',
    unresolved: 'Choose an item', nodata: 'No usable value', unknown: 'Unknown in source – skipped',
  };
  const badge = s => h('span', { class: 'wsbe-badge b-' + s }, STATUS_TEXT[s]);

  function fmtValue(type, v) {
    switch (type) {
      case 'item': return qLink(v.id || 'Q' + v['numeric-id']);
      case 'url': return h('a', { href: v, target: '_blank', class: 'wsbe-break' }, safeDecode(v));
      case 'string': return String(v);
      case 'commons': return h('a', { href: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(v.replace(/ /g, '_')), target: '_blank', class: 'wsbe-break' }, v);
      case 'mono': return `${v.text} (${v.language})`;
      case 'time': return v.time.replace(/^\+/, '').slice(0, v.precision >= 11 ? 10 : v.precision === 10 ? 7 : 4);
      case 'quantity': return String(v.amount).replace(/^\+/, '');
    }
    return '';
  }

  function renderAll() {
    const refs = document.getElementById('wsbe-refs');
    if (refs) refs.checked = !!S.opts.refs;
    document.getElementById('wsbe-loadinfo').textContent = S.rows.length
      ? `${S.rows.length} rows, ${S.headers.length} columns loaded.` : 'Choose a .csv or .tsv file exported from the Wikisource index scraper.';
    renderMapping(); renderNav();
    if (!S.rows.length) document.getElementById('wsbe-row').replaceChildren();
  }

  function renderMapping() {
    const box = document.getElementById('wsbe-map');
    box.replaceChildren(h('summary', null, 'Column mapping'));
    if (!S.headers.length) return;
    const tbl = h('table', { class: 'wsbe-maptbl' });
    FIELDS.forEach(f => {
      const sel = h('select', {
        onchange: e => { S.map[f.key] = e.target.value; saveSession(); loadRow(S.idx); },
      }, h('option', { value: '' }, '— not used —'), S.headers.map(hd => h('option', { value: hd, selected: S.map[f.key] === hd }, hd)));
      tbl.append(h('tr', null, h('td', null, f.prop ? propLink(f.prop) : '', f.prop ? ' ' : '', f.label), h('td', null, sel)));
    });
    box.append(tbl, h('p', { class: 'wsbe-muted' }, `Always checked: P31 → ${Q_EDITION} (version, edition or translation), P407 → ${Q_MALAYALAM} (Malayalam).`));
  }

  function renderNav() {
    const box = document.getElementById('wsbe-nav');
    box.replaceChildren();
    if (!S.rows.length) { box.hidden = true; return; }
    box.hidden = false;
    const done = S.rows.filter(r => r._done).length;
    const jump = h('select', { onchange: e => loadRow(+e.target.value) },
      S.rows.map((r, i) => h('option', { value: i, selected: i === S.idx },
        `${i + 1}. ${r._done ? '✓ ' : ''}${r._qid ? r._qid + ' – ' : ''}${cellOf(r, 'title').slice(0, 60) || '(no title)'}`)));
    box.append(
      h('button', { class: 'wsbe-btn', disabled: S.idx === 0, onclick: () => loadRow(S.idx - 1) }, '‹ Previous'),
      jump,
      h('button', { class: 'wsbe-btn', disabled: S.idx >= S.rows.length - 1, onclick: () => loadRow(S.idx + 1) }, 'Next ›'),
      h('button', { class: 'wsbe-btn wsbe-primary', onclick: markDoneNext }, 'Mark done and go to next'),
      h('span', { class: 'wsbe-muted' }, `${done} of ${S.rows.length} done`)
    );
  }

  function renderRow() {
    const box = document.getElementById('wsbe-row');
    if (!S.cur) { box.replaceChildren(); return; }
    box.replaceChildren(renderBook(), renderStatements());
  }

  function renderBook() {
    const cur = S.cur, row = cur.row;
    const thumb = cellOf(row, 'cover');
    const meta = [cellOf(row, 'author'), cellOf(row, 'publisher'), cellOf(row, 'place'), cellOf(row, 'year')].filter(Boolean).join(', ');
    const card = h('div', { class: 'wsbe-card' },
      h('div', { class: 'wsbe-book-top' },
        thumb ? h('a', { href: cur.indexUrl || thumb, target: '_blank' }, h('img', { src: thumb, class: 'wsbe-thumb', alt: 'Cover scan' })) : null,
        h('div', null,
          h('div', { class: 'wsbe-title' }, cellOf(row, 'title') || '(no title)'),
          meta ? h('div', { class: 'wsbe-muted' }, meta) : null,
          cur.indexUrl ? h('a', { href: cur.indexUrl, target: '_blank' }, 'Open index page on Wikisource') : null,
          cur.loading ? h('div', { class: 'wsbe-muted' }, 'Looking up Wikidata…') : null)));

    if (cur.entity) {
      const e = cur.entity, p31 = claimIds(e, 'P31');
      card.append(h('div', { class: 'wsbe-item' },
        h('strong', null, 'Book item: '), qLink(e.id), ' ', copyBtn(e.id),
        labels[e.id] && labels[e.id].desc ? h('span', { class: 'wsbe-muted' }, ' – ' + labels[e.id].desc) : null,
        cur.autoPicked ? h('span', { class: 'wsbe-badge' }, 'matched by ' + cur.autoPicked) : null,
        h('button', {
          class: 'wsbe-btn wsbe-quiet', disabled: cur.busy,
          onclick: () => { cur.entity = null; delete row._qid; cur.autoPicked = ''; saveSession(); renderNav(); renderRow(); },
        }, 'Use a different item')));
      if (p31.length && !p31.includes(Q_EDITION)) {
        card.append(h('div', { class: 'wsbe-msg wsbe-msg-warn' },
          `This item is "${p31.map(labelOf).join(', ')}", not an edition. If it describes the work in general, create a separate edition item and link it with P629.`,
          h('div', null, h('button', { class: 'wsbe-btn', onclick: () => startEditionOf(e.id) }, 'Create a new edition of this work'))));
      }
      return card;
    }

    if (cur.workQid) {
      card.append(h('div', { class: 'wsbe-msg wsbe-msg-info' }, 'The new item will be an edition of ', qLink(cur.workQid),
        '. Add the P629 statement below after creating it.'));
    } else if (cur.candidates.length) {
      card.append(h('div', { class: 'wsbe-sub' }, 'Possible existing items'));
      cur.candidates.forEach(c => card.append(h('div', { class: 'wsbe-cand' },
        h('div', null, qLink(c.id), c.desc ? h('span', { class: 'wsbe-muted' }, ' – ' + c.desc) : null),
        h('div', { class: 'wsbe-muted' },
          c.p31.length ? 'instance of: ' + c.p31.map(labelOf).join(', ') : 'no instance of', c.year ? `; published ${c.year}` : ''),
        h('div', null, c.methods.map(m => h('span', { class: 'wsbe-badge' + (STRONG.has(m) ? ' b-match' : '') }, m))),
        h('div', null,
          h('button', { class: 'wsbe-btn' + (c.isEdition ? ' wsbe-primary' : ''), disabled: cur.busy, onclick: () => useItem(c.id) }, 'Use this item'),
          !c.isEdition ? h('button', { class: 'wsbe-btn', disabled: cur.busy, onclick: () => startEditionOf(c.id) }, 'Create a new edition of this work') : null))));
    } else if (!cur.loading) {
      card.append(h('p', { class: 'wsbe-muted' }, 'No existing item found for this book.'));
    }

    const f = cur.newForm;
    const bind = k => e => { f[k] = e.target.value; };
    card.append(h('div', { class: 'wsbe-newform' },
      h('div', { class: 'wsbe-sub' }, 'Create a new book item'),
      h('label', null, 'Label ', h('input', { type: 'text', value: f.label, size: 40, onchange: bind('label') })),
      h('label', null, ' language ', h('input', { type: 'text', value: f.lang, size: 4, onchange: bind('lang') })),
      h('div', null, h('label', null, 'Description (ml) ', h('input', { type: 'text', value: f.ml, size: 40, onchange: bind('ml') }))),
      h('div', null, h('label', null, 'Description (en) ', h('input', { type: 'text', value: f.en, size: 40, onchange: bind('en') }))),
      h('button', {
        class: 'wsbe-btn wsbe-primary', disabled: cur.busy || !f.label,
        onclick: () => withBusy(async c => {
          const id = await createItem(f.label.trim(), f.lang.trim() || 'ml', { ml: f.ml, en: f.en });
          await loadEntity(c, id);
        }),
      }, 'Create item'),
      h('span', { class: 'wsbe-muted' }, ' or use QID '),
      h('input', {
        type: 'text', size: 10, placeholder: 'Q…',
        onchange: e => { const v = e.target.value.trim().toUpperCase(); if (/^Q\d+$/.test(v)) useItem(v); },
      })));
    return card;
  }

  function useItem(id) {
    withBusy(async cur => { await loadEntity(cur, id); });
  }

  function startEditionOf(workId) {
    const cur = S.cur;
    cur.workQid = workId;
    cur.entity = null; delete cur.row._qid; cur.autoPicked = '';
    if (!cur.stmts.some(s => s.prop === 'P629')) {
      cur.stmts.splice(2, 0, { prop: 'P629', label: 'edition or translation of', type: 'item', csv: '(chosen work)', qid: workId, fixed: true });
    } else {
      cur.stmts.find(s => s.prop === 'P629').qid = workId;
    }
    saveSession(); renderNav(); renderRow();
  }

  function renderStatements() {
    const cur = S.cur;
    const missing = cur.stmts.filter(st => statusOf(st) === 'missing');
    const tbody = h('tbody', null, cur.stmts.map(renderStmt));
    return h('div', { class: 'wsbe-card' },
      h('div', { class: 'wsbe-row-head' },
        h('strong', null, 'Statements'),
        h('label', { class: 'wsbe-muted' }),
        h('button', {
          class: 'wsbe-btn wsbe-primary', disabled: !cur.entity || !missing.length || cur.busy, onclick: addAllMissing,
        }, `Add all missing (${missing.length} ${missing.length === 1 ? 'edit' : 'edits'})`)),
      h('div', { class: 'wsbe-scroll' },
        h('table', { class: 'wsbe-tbl' },
          h('thead', null, h('tr', null, ['Property', 'From the file', 'On Wikidata now', ''].map(t => h('th', null, t)))),
          tbody)));
  }

  function renderStmt(st) {
    const cur = S.cur, status = statusOf(st);
    const ex = cur.entity && st.type !== 'sitelink' ? existing(st.prop) : [];
    const exCell = !cur.entity ? '' : st.type === 'sitelink'
      ? (currentSitelink() ? wsLink(currentSitelink()) : h('span', { class: 'wsbe-muted' }, 'none'))
      : (ex.length ? ex.map(e => h('div', null, e.v ? fmtValue(st.type, e.v) : (e.snaktype === 'somevalue' ? 'unknown value' : 'no value')))
        : h('span', { class: 'wsbe-muted' }, 'none'));
    let action = null;
    if (['missing', 'differs', 'ready'].includes(status)) {
      action = h('button', {
        class: 'wsbe-btn' + (status === 'missing' ? ' wsbe-primary' : ''),
        disabled: !cur.entity || cur.busy, title: cur.entity ? '' : 'Choose or create the book item first',
        onclick: () => {
          if (st.type === 'sitelink' && status === 'differs' &&
            !confirm(`Replace the existing link "${currentSitelink()}" with "${st.page}"?`)) return;
          doAdd(st);
        },
      }, st.type === 'sitelink' ? (status === 'differs' ? 'Replace link' : 'Add link') : status === 'differs' ? 'Add as extra value' : 'Add');
    }
    return h('tr', { class: 'wsbe-st-' + status },
      h('td', null, st.type === 'sitelink' ? h('span', null, 'mlwikisource') : propLink(st.prop), h('div', { class: 'wsbe-muted' }, st.label)),
      h('td', null, renderInput(st)),
      h('td', null, exCell),
      h('td', null, badge(status), h('div', null, action)));
  }

  function renderInput(st) {
    const rerender = () => renderRow();
    const note = st.note ? h('div', { class: 'wsbe-muted' }, st.note) : null;
    if (st.fixed) return h('div', null, qLink(st.qid));
    if (st.unknown) return h('div', null, st.csv);
    switch (st.type) {
      case 'sitelink':
        return h('div', null,
          h('input', { type: 'text', class: 'wsbe-wide', value: st.page, onchange: e => { st.page = e.target.value.trim(); st.blocked = false; st.owner = null; st.note = 'edited by hand – not verified'; rerender(); } }),
          h('div', null, wsLink(st.page)), note,
          st.owner && (!S.cur.entity || st.owner !== S.cur.entity.id)
            ? h('div', { class: 'wsbe-msg wsbe-msg-warn' }, 'Already linked from ', qLink(st.owner)) : null);
      case 'url':
        return h('div', null, h('input', { type: 'text', class: 'wsbe-wide', value: st.value || '', onchange: e => { st.value = normUrl(e.target.value); rerender(); } }), note);
      case 'mono':
        return h('div', null,
          h('input', { type: 'text', class: 'wsbe-wide', value: st.text, onchange: e => { st.text = e.target.value.trim(); rerender(); } }),
          h('label', { class: 'wsbe-muted' }, ' language ', h('input', { type: 'text', size: 4, value: st.lang, onchange: e => { st.lang = e.target.value.trim(); rerender(); } })),
          note);
      case 'time':
        return h('div', null, h('input', { type: 'text', size: 6, value: st.year, onchange: e => { st.year = e.target.value.trim(); rerender(); } }),
          h('span', { class: 'wsbe-muted' }, ' year (Gregorian)'), st.csv !== st.year ? h('div', { class: 'wsbe-muted' }, 'file: ' + st.csv) : null);
      case 'commons':
        return h('div', null, h('input', { type: 'text', class: 'wsbe-wide', value: st.value || '', onchange: e => { st.value = st.fileName = normFile(e.target.value); st.note = 'edited by hand – not verified'; rerender(); } }), note);
      case 'quantity':
        return h('div', null, h('input', { type: 'text', size: 6, value: st.n || '', onchange: e => { const n = parseInt(e.target.value, 10); st.n = n > 0 ? n : null; rerender(); } }), note);
      case 'item':
      case 'string':
        return renderPart(st);
    }
    return '';
  }

  function renderPart(st) {
    const opts = [h('option', { value: '' }, st.candidates == null ? 'searching…' : (st.candidates.length ? '— choose an item —' : 'no matches found'))];
    if (st.qid && !(st.candidates || []).some(c => c.id === st.qid)) {
      opts.push(h('option', { value: st.qid, selected: true }, `${labelOf(st.qid)} (${st.qid})`));
    }
    (st.candidates || []).forEach(c => opts.push(h('option', { value: c.id, selected: !st.asString && c.id === st.qid },
      `${c.label} (${c.id})${c.desc ? ' – ' + c.desc : ''}`)));
    if (st.stringProp) {
      opts.push(h('option', { value: '__string', selected: st.asString }, `✎ Not on Wikidata – add as ${PROP_LABELS[st.stringProp]} (${st.stringProp})`));
    }
    opts.push(h('option', { value: '__new' }, '+ Create a new item…'));

    const wrap = h('div', { class: 'wsbe-part' },
      h('div', null, h('span', { class: 'wsbe-muted' }, 'file: '), st.csv),
      h('div', null,
        h('input', { type: 'text', size: 26, value: st.search, onchange: e => { st.search = e.target.value.trim(); } }),
        h('button', {
          class: 'wsbe-btn', onclick: async () => {
            st.candidates = null; renderRow();
            try { await searchPart(st); } catch (e) { showMsg(e.message, 'error'); st.candidates = []; }
            renderRow();
          },
        }, 'Search')),
      h('select', {
        class: 'wsbe-wide', onchange: e => {
          const v = e.target.value;
          if (v === '__new') { st.showNew = true; }
          else if (v === '__string') { setAsString(st, true); st.how = 'chosen by you'; st.showNew = false; remember(st); }
          else { setAsString(st, false); st.qid = v || null; st.how = v ? 'chosen by you' : ''; st.showNew = false; remember(st); }
          renderRow();
        },
      }, opts),
      st.asString ? null : h('input', {
        type: 'text', size: 10, placeholder: 'or type QID',
        onchange: async e => {
          const v = e.target.value.trim().toUpperCase();
          if (!/^Q\d+$/.test(v)) return;
          setAsString(st, false);
          st.qid = v; st.how = 'typed by you'; remember(st);
          try { await fetchLabels([v]); } catch (err) { /* label stays as QID */ }
          renderRow();
        },
      }),
      st.asString ? h('div', null,
        h('label', null, `${PROP_LABELS[st.stringProp]}: `,
          h('input', { type: 'text', size: 26, value: st.strValue, onchange: e => { st.strValue = e.target.value.trim(); renderRow(); } })),
        h('div', { class: 'wsbe-muted' }, `Adds ${st.stringProp} instead of ${st.origProp}. Replace it with ${st.origProp} once an item exists.`)) : null,
      !st.asString && st.qid ? h('div', null, 'Selected: ', qLink(st.qid), st.how ? h('span', { class: 'wsbe-muted' }, ' – ' + st.how) : null) : null);

    if (st.showNew) {
      const lab = h('input', { type: 'text', size: 26, value: st.search });
      const desc = h('input', { type: 'text', size: 30, value: st.newDesc || '', placeholder: 'description (optional)' });
      const p31 = h('select', null, NEW_P31.map(([q, t]) => h('option', { value: q, selected: q === (st.newP31 || '') }, q ? `${t} (${q})` : t)));
      const extras = (st.newClaims || []).map(([p, q]) => ({ p, q, box: h('input', { type: 'checkbox', checked: true }) }));
      // Gender is offered for people (new items whose default instance of is human).
      const isPerson = st.newP31 === 'Q5';
      const gName = 'wsbe-g-' + Math.random().toString(36).slice(2);
      const genderRadios = GENDERS.map(([q, t]) => ({ q, el: h('input', { type: 'radio', name: gName, value: q, checked: q === '' }), t }));
      const genderRow = isPerson ? h('div', { class: 'wsbe-gender' }, `${PROP_LABELS.P21} (P21): `,
        genderRadios.map(g => h('label', null, g.el, ' ' + g.t + (g.q ? ` (${g.q})` : '')))) : null;
      const updateGender = () => { if (genderRow) genderRow.hidden = p31.value !== 'Q5'; };
      p31.addEventListener('change', updateGender); updateGender();
      wrap.append(h('div', { class: 'wsbe-newform' },
        h('div', null, 'Label ', lab), h('div', null, 'Description ', desc), h('div', null, 'Instance of ', p31),
        genderRow,
        extras.map(x => h('div', null, h('label', null, x.box, ` ${PROP_LABELS[x.p] || x.p} (${x.p}) → ${labelOf(x.q)} (${x.q})`))),
        h('button', {
          class: 'wsbe-btn wsbe-primary', disabled: S.cur.busy,
          onclick: () => withBusy(async () => {
            const text = lab.value.trim();
            if (!text) throw new Error('A label is needed to create an item.');
            const lang = hasMalayalam(text) ? 'ml' : 'en';
            const dlang = hasMalayalam(desc.value) ? 'ml' : 'en';
            const claims = [['P31', p31.value]].concat(extras.filter(x => x.box.checked).map(x => [x.p, x.q]));
            const g = genderRadios.find(x => x.el.checked);
            if (isPerson && p31.value === 'Q5' && g && g.q) claims.push(['P21', g.q]);
            setAsString(st, false);
            st.qid = await createItem(text, lang, { [dlang]: desc.value }, claims);
            st.how = 'newly created'; st.showNew = false; remember(st);
          }),
        }, 'Create item'),
        h('button', { class: 'wsbe-btn wsbe-quiet', onclick: () => { st.showNew = false; renderRow(); } }, 'Cancel')));
    }
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* Shell & styles                                                      */
  /* ------------------------------------------------------------------ */

  const CSS = `
#wsbe{--wb-bg:var(--background-color-base,#fff);--wb-fg:var(--color-base,#202122);--wb-sub:var(--color-subtle,#54595d);
 --wb-line:var(--border-color-subtle,#c8ccd1);--wb-soft:var(--background-color-neutral-subtle,#f8f9fa);
 --wb-acc:var(--color-progressive,#36c);font-size:14px;color:var(--wb-fg);max-width:1200px}
#wsbe .wsbe-card{background:var(--wb-bg);border:1px solid var(--wb-line);border-radius:4px;padding:10px 14px;margin:0 0 12px}
#wsbe summary{cursor:pointer;font-weight:600}
#wsbe .wsbe-btn{font:inherit;padding:4px 10px;border:1px solid var(--wb-line);border-radius:2px;background:var(--wb-soft);color:var(--wb-fg);cursor:pointer;margin:2px 4px 2px 0}
#wsbe .wsbe-btn:hover:not([disabled]){border-color:var(--wb-acc)}
#wsbe .wsbe-btn:focus-visible,#wsbe input:focus-visible,#wsbe select:focus-visible{outline:2px solid var(--wb-acc);outline-offset:1px}
#wsbe .wsbe-btn[disabled]{opacity:.45;cursor:default}
#wsbe .wsbe-primary{background:var(--wb-acc);border-color:var(--wb-acc);color:#fff}
#wsbe .wsbe-quiet{background:transparent}
#wsbe .wsbe-muted{color:var(--wb-sub);font-size:12px}
#wsbe .wsbe-sub{font-weight:600;margin:8px 0 4px}
#wsbe .wsbe-nav{display:flex;flex-wrap:wrap;align-items:center;gap:6px;position:sticky;top:0;z-index:5}
#wsbe .wsbe-nav select{max-width:min(520px,100%)}
#wsbe .wsbe-book-top{display:flex;gap:14px;align-items:flex-start}
#wsbe .wsbe-thumb{width:96px;border:1px solid var(--wb-line);display:block}
#wsbe .wsbe-title{font-size:20px;font-weight:600;line-height:1.3}
#wsbe .wsbe-item{margin-top:10px}
#wsbe .wsbe-cand{border-top:1px solid var(--wb-line);padding:8px 0}
#wsbe .wsbe-copy{font-family:monospace;padding:1px 8px}
#wsbe .wsbe-gender label{margin-right:10px;white-space:nowrap}
#wsbe .wsbe-badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;background:var(--wb-soft);border:1px solid var(--wb-line);margin:2px 4px 2px 0;white-space:nowrap}
#wsbe .b-match{color:#14866d;border-color:#14866d}
#wsbe .b-missing{color:var(--wb-acc);border-color:var(--wb-acc)}
#wsbe .b-differs{color:#a66200;border-color:#a66200}
#wsbe .b-unresolved{color:#d33;border-color:#d33}
#wsbe .wsbe-scroll{overflow-x:auto}
#wsbe .wsbe-tbl{width:100%;border-collapse:collapse}
#wsbe .wsbe-tbl th,#wsbe .wsbe-tbl td{border-bottom:1px solid var(--wb-line);padding:6px;vertical-align:top;text-align:left}
#wsbe .wsbe-tbl td:first-child{white-space:nowrap}
#wsbe tr.wsbe-st-match td{background:rgba(20,134,109,.07)}
#wsbe tr.wsbe-st-differs td{background:rgba(166,98,0,.08)}
#wsbe tr.wsbe-st-unresolved td{background:rgba(221,51,51,.05)}
#wsbe tr.wsbe-st-nodata td,#wsbe tr.wsbe-st-unknown td{opacity:.7}
#wsbe .wsbe-msg{padding:8px 12px;border-radius:2px;margin:8px 0}
#wsbe .wsbe-msg-error{background:#fee7e6;color:#b32424}
#wsbe .wsbe-msg-warn{background:#fef6e7;color:#7a4b00}
#wsbe .wsbe-msg-info{background:#eaf3ff;color:#202122}
#wsbe input[type=text],#wsbe select{font:inherit;padding:2px 4px;max-width:100%;box-sizing:border-box}
#wsbe .wsbe-wide{width:100%;min-width:220px}
#wsbe .wsbe-part{display:flex;flex-direction:column;gap:4px;min-width:260px}
#wsbe .wsbe-newform{border:1px solid var(--wb-line);padding:8px;border-radius:2px;background:var(--wb-soft);margin-top:10px}
#wsbe .wsbe-newform label,#wsbe .wsbe-newform div{margin:2px 0}
#wsbe .wsbe-break{word-break:break-all}
#wsbe .wsbe-row-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}
#wsbe .wsbe-maptbl td{padding:2px 8px 2px 0}
#wsbe #wsbe-logl{font-size:12px;max-height:240px;overflow:auto;margin:6px 0 0 1.5em}
`;

  function buildShell() {
    return h('div', { id: 'wsbe' },
      h('div', { class: 'wsbe-card' },
        h('strong', null, 'Data file '),
        h('input', { type: 'file', accept: '.csv,.tsv,.txt', onchange: e => readFile(e.target.files[0]) }),
        h('button', { class: 'wsbe-btn', onclick: exportTSV }, 'Export TSV with QIDs'),
        h('button', { class: 'wsbe-btn wsbe-quiet', onclick: clearSession }, 'Clear session'),
        h('div', null, h('label', null,
          h('input', { type: 'checkbox', id: 'wsbe-refs', onchange: e => { S.opts.refs = e.target.checked; saveSession(); } }),
          ' Add a reference to new statements (P854 = index page URL, P813 = today)')),
        h('div', { id: 'wsbe-loadinfo', class: 'wsbe-muted' })),
      h('details', { class: 'wsbe-card', id: 'wsbe-map' }),
      h('div', { class: 'wsbe-card wsbe-nav', id: 'wsbe-nav', hidden: true }),
      h('div', { id: 'wsbe-msg' }),
      h('div', { id: 'wsbe-row' }),
      h('details', { class: 'wsbe-card', open: true }, h('summary', null, 'Edits made in this session'), h('ol', { id: 'wsbe-logl' })),
      h('p', { class: 'wsbe-muted' }, 'Script written and maintained by ',
        h('a', { href: '/wiki/User:Jameela_P.', target: '_blank' }, 'User:Jameela P.'),
        ' as part of the Wiki Librarians Network.'));
  }

  function init() {
    api = new mw.Api({ parameters: { formatversion: 2, errorformat: 'plaintext' } });
    mw.util.addCSS(CSS);
    document.title = 'Wikisource → Wikidata book editor';
    const heading = document.getElementById('firstHeading');
    if (heading) heading.textContent = 'Wikisource → Wikidata book editor';
    document.getElementById('mw-content-text').replaceChildren(buildShell());
    if (!mw.config.get('wgUserName')) showMsg('You are not logged in. Log in before adding statements.', 'warn');
    const sess = loadJSON(LS_SESSION, null);
    if (sess && sess.rows && sess.rows.length) {
      Object.assign(S, sess, { opts: Object.assign({ refs: true }, sess.opts) });
      renderAll(); loadRow(Math.min(S.idx || 0, S.rows.length - 1));
    } else {
      S.opts.refs = true; renderAll();
    }
  }

  mw.loader.using(['mediawiki.api', 'mediawiki.ForeignApi', 'mediawiki.util']).then(() => $(init));
}());
