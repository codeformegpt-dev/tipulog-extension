/* sidepanel.js: החלונית. קוראת את המצב מ-chrome.storage ושולחת פקודות ל-background.js.
   לא משנה את המצב בעצמה. כל טקסט מוצג דרך textContent, בלי innerHTML. */
'use strict';
(() => {
  const C = globalThis.TIP_CONFIG;
  const X = globalThis.TipCSV;
  const T = X.t;
  const $ = id => document.getElementById(id);

  let state = null;
  let settings = { autoSave: false };
  let activeTab = null;
  let flash = null;          // הודעה זמנית מפקודה שנכשלה
  let lastCurrentKey = null;
  let renderQueued = false;

  const PHASE_TEXT = { list: 'בודק אם כבר קיימת', form: 'ממלא את הטופס', saving: 'שומר', awaitSave: 'מחכה שתלחץ "שמירה" בטיפולוג' };

  // ---------- תקשורת ----------
  async function send(msg) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      return res || { ok: false, error: 'אין תשובה מהתוסף' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  function showFlash(text) { flash = text || null; render(); }

  async function refresh() {
    const d = await chrome.storage.local.get(['state', 'settings']);
    state = d.state || null;
    settings = Object.assign({ autoSave: false }, d.settings);
    render();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.state || changes.settings)) refresh();
  });

  // ---------- הלשונית הפעילה ----------
  async function updateTabState() {
    let tab = null;
    try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) { tab = null; }
    const guid = tab ? X.guidFrom(tab.url) : null;
    activeTab = tab ? { id: tab.id, url: tab.url, guid, route: guid ? X.routeOf(tab.url, guid) : X.routeOf(tab.url, '') } : null;
    const el = $('tabState');
    if (activeTab && activeTab.route === 'list') { el.textContent = '✓ טיפולוג: מסך הפעילויות'; el.className = 'tab-state ok'; }
    else if (activeTab && activeTab.route === 'form') { el.textContent = '✓ טיפולוג: טופס הוספת פעילות'; el.className = 'tab-state ok'; }
    else if (activeTab && activeTab.route === 'other') { el.textContent = 'טיפולוג פתוח, אבל לא במסך הפעילויות של המנהלת'; el.className = 'tab-state warn'; }
    else { el.textContent = 'הלשונית הפעילה אינה טיפולוג'; el.className = 'tab-state warn'; }
  }

  // ---------- ציור ----------
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderNow(); });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderNow() {
    const rows = (state && state.rows) || [];
    const run = (state && state.run) || { status: 'idle' };
    const c = X.counts(rows);
    const running = run.status === 'running';
    const current = running && run.currentKey ? rows.find(r => r.key === run.currentKey) : null;

    // הודעה לפני הלכידה
    const banner = $('banner');
    banner.hidden = !!C.CAPTURED;
    banner.textContent = C.CAPTURED ? '' : 'גרסה לפני הלכידה: אפשר לטעון CSV ולבדוק את השורות. ההרצה תיפתח אחרי השלמת פרטי המסך.';

    // קובץ ומונים
    $('fileName').textContent = state && state.fileName
      ? state.fileName + (state.loadedAt ? ' · נטען ' + new Date(state.loadedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '')
      : 'לא נטען קובץ';
    const counts = $('counts');
    counts.replaceChildren();
    if (rows.length) {
      [['סה״כ', c.total], ['ממתינות', c.ready + c.active], ['דווחו עכשיו', c.done], ['דווחו קודם', c.csvDone],
        ['כבר קיימות', c.duplicate], ['בעיות', c.error], ['דולגו', c.skipped], ['לא מוכנות', c.notReady]]
        .filter(([label, n], i) => i === 0 || n > 0)
        .forEach(([label, n]) => counts.appendChild(el('span', 'chip', label + ': ' + n)));
    }

    // כפתורים
    const canRun = !running && c.ready > 0 && !!C.CAPTURED;
    $('start').disabled = !canRun;
    $('next').disabled = !canRun;
    $('skip').disabled = !current || current.phase === 'saving';
    $('stop').disabled = !running;
    $('file').disabled = running;
    $('fileBtn').classList.toggle('disabled', running);
    $('fileBtn').style.opacity = running ? '.45' : '';
    $('export').disabled = !rows.length;
    $('reset').disabled = running;

    // שמירה אוטומטית
    $('autoSave').checked = !!settings.autoSave;
    const hint = $('autoSaveHint');
    hint.textContent = settings.autoSave
      ? 'דלוק: התוסף ממלא, מאמת ולוחץ "שמירה" לבד בכל שורה.'
      : 'כבוי: התוסף ממלא ומחכה שתלחץ "שמירה" בטיפולוג.';
    hint.className = 'hint' + (settings.autoSave ? ' on' : '');

    // סטטוס
    const status = $('status');
    if (flash) { status.textContent = flash; status.className = 'status error'; }
    else if (running && current && current.phase === 'awaitSave') { status.textContent = run.message; status.className = 'status wait'; }
    else if (running) { status.textContent = run.message || T('MSG_STARTING'); status.className = 'status running'; }
    else if (run.status === 'error') { status.textContent = 'נעצר: ' + run.error; status.className = 'status error'; }
    else { status.textContent = run.message || ''; status.className = 'status'; }

    renderRows(rows, run, current);
    renderLog((state && state.log) || []);

    // מעבר לשורה שבטיפול
    if (current && current.key !== lastCurrentKey) {
      const node = document.querySelector('[data-key="' + CSS.escape(current.key) + '"]');
      if (node) node.scrollIntoView({ block: 'nearest' });
    }
    lastCurrentKey = current ? current.key : null;
  }

  function matchesFilter(r, f) {
    switch (f) {
      case 'ready': return r.status === 'ready' || r.status === 'active';
      case 'problems': return r.status === 'error' || r.status === 'duplicate' || r.status === 'skipped';
      case 'done': return r.status === 'done' || r.status === 'csvDone';
      case 'notReady': return r.status === 'notReady';
      default: return true;
    }
  }

  function renderRows(rows, run, current) {
    const box = $('rows');
    const f = $('filter').value;
    const frag = document.createDocumentFragment();
    const shown = rows.filter(r => matchesFilter(r, f));
    if (!rows.length) frag.appendChild(el('div', 'empty', 'טען קובץ CSV כדי להתחיל'));
    else if (!shown.length) frag.appendChild(el('div', 'empty', 'אין שורות בסינון הזה'));

    shown.forEach(r => {
      const n = r.n, raw = r.raw;
      const card = el('div', 'row' + (current && current.key === r.key ? ' current' : ''));
      card.dataset.key = r.key;

      const top = el('div', 'row-top');
      top.appendChild(el('span', 'row-num', '#' + r.idx));
      const main = el('div', 'row-main');
      main.appendChild(el('div', 'row-title', n.label || raw.label || n.type || '(בלי נושא)'));
      const when = (n.date || raw.date || 'אין תאריך') + ' · ' + (n.start || raw.start_time || '?') + '–' + (n.end || raw.end_time || '?');
      const who = n.name || 'בלי מודרך';
      main.appendChild(el('div', 'row-sub', when + ' · ' + who + ' · ' + (n.online ? 'אונליין' : 'פרונטלי') + ' · ' + (n.type || raw.type)));
      top.appendChild(main);
      top.appendChild(el('span', 'badge ' + r.status, T('STATUS_' + r.status)));
      card.appendChild(top);

      // הסיבות וההערות
      const lines = [];
      if (r.status === 'active' && r.phase) lines.push(PHASE_TEXT[r.phase] || r.phase);
      if (r.status === 'notReady' || r.status === 'csvDone') (r.reasons || []).forEach(x => lines.push(x.text));
      if (r.status === 'notReady' && String(raw.notes || '').trim()) lines.push('notes: ' + raw.notes.trim());
      (r.notes || []).forEach(x => lines.push(x));
      if (r.status === 'ready' || r.status === 'active' || r.status === 'done') (r.info || []).forEach(x => lines.push(x));
      if (r.force && r.status === 'ready') lines.push('יוזן למרות שקיים בטיפולוג');
      if (lines.length) {
        const notes = el('div', 'row-notes');
        lines.forEach(x => notes.appendChild(el('div', null, x)));
        card.appendChild(notes);
      }

      if (r.status === 'duplicate' && run.status !== 'running') {
        const act = el('div', 'row-actions');
        const b = el('button', 'btn small', 'הזן בכל זאת');
        b.addEventListener('click', () => twoStep(b, async () => {
          const res = await send({ cmd: 'force', key: r.key });
          showFlash(res.ok ? null : res.error);
        }));
        act.appendChild(b);
        card.appendChild(act);
      }
      frag.appendChild(card);
    });
    box.replaceChildren(frag);
  }

  function renderLog(log) {
    const ol = $('log');
    const frag = document.createDocumentFragment();
    log.slice(-80).reverse().forEach(item => {
      const li = el('li');
      li.appendChild(el('time', null, new Date(item.t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
      li.appendChild(document.createTextNode(item.msg));
      frag.appendChild(li);
    });
    ol.replaceChildren(frag);
  }

  // אישור בשתי לחיצות (בלי חלונות קופצים)
  function twoStep(btn, action) {
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      btn.textContent = btn.dataset.label;
      action();
      return;
    }
    btn.dataset.label = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = 'בטוח? לחץ שוב';
    setTimeout(() => {
      if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; }
    }, 4000);
  }

  // ---------- פעולות ----------
  async function start(mode) {
    await updateTabState();
    if (!activeTab || !activeTab.guid) { showFlash(T('ERR_NO_TAB')); return; }
    const res = await send({ cmd: 'start', mode, tabId: activeTab.id });
    showFlash(res.ok ? null : res.error);
  }

  $('start').addEventListener('click', () => start('all'));
  $('next').addEventListener('click', () => start('one'));
  $('skip').addEventListener('click', async () => {
    const res = await send({ cmd: 'skip' });
    showFlash(res.ok ? null : res.error);
  });
  $('stop').addEventListener('click', async () => {
    const res = await send({ cmd: 'stop' });
    showFlash(res.ok ? null : res.error);
  });
  $('autoSave').addEventListener('change', async e => {
    const res = await send({ cmd: 'setAutoSave', value: e.target.checked });
    if (!res.ok) showFlash(res.error);
  });
  $('filter').addEventListener('change', render);

  $('file').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let text;
    try { text = await file.text(); } catch (err) { showFlash('לא הצלחתי לקרוא את הקובץ'); return; }
    if (text.includes('�')) { showFlash('הקובץ לא בקידוד UTF-8. הורד אותו שוב מהגיליון כ-CSV.'); return; }
    const res = await send({ cmd: 'load', fileName: file.name, text });
    showFlash(res.ok ? null : res.error);
  });

  $('export').addEventListener('click', () => {
    if (!state || !state.rows || !state.rows.length) return;
    const blob = new Blob([X.buildOutput(state.rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = X.outputFileName(state.fileName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });

  $('reset').addEventListener('click', () => twoStep($('reset'), async () => {
    const res = await send({ cmd: 'reset' });
    showFlash(res.ok ? null : res.error);
  }));

  // ---------- הפעלה ----------
  chrome.tabs.onActivated.addListener(updateTabState);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete' || info.url) updateTabState(); });
  setInterval(updateTabState, 3000);

  // בזמן ריצה: "דופק" כל 20 שניות, כדי שמנהל הריצה יישאר ער וימשיך אם נעצר
  setInterval(() => {
    if (state && state.run && state.run.status === 'running') send({ cmd: 'ping' });
  }, 20000);

  updateTabState();
  refresh();
  send({ cmd: 'ping' });
})();
