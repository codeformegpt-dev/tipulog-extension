/* background.js: מנהל הריצה (service worker).
   שומר את המצב ב-chrome.storage.local ומקדם כל שורה שלב אחרי שלב:
   רשימה ובדיקת כפילות ← טופס ומילוי ← אימות ← שמירה ← חזרה לרשימה ווידוא ← done? = TRUE.
   כל פעולה בתוך דף טיפולוג עוברת דרך page.js (MAIN world).
   המצב נשמר אחרי כל שלב, ולכן ריצה ממשיכה גם אם ה-service worker נעצר והתעורר. */
'use strict';

if (typeof importScripts === 'function') importScripts('config.js', 'csv.js');

const C = globalThis.TIP_CONFIG;
const X = globalThis.TipCSV;
const T = (key, vars) => X.t(key, vars);

// ---------- סוגי תקלות ----------
class GeneralError extends Error {} // תקלה כללית: עוצרת את כל הריצה
class RowError extends Error {}     // בעיה בשורה: הערה, דילוג והמשך
class Abort extends Error {}        // פקודה (עצור/דלג) שינתה את הריצה: עוזבים את השלב בשקט

// ---------- מצב ----------
const KEY_STATE = 'state';
const KEY_SETTINGS = 'settings';
const KEY_RUN_TAB = 'runTab'; // ב-storage.session: נמחק כשהדפדפן נסגר
const SKIP_SAVE = Symbol('skip-save');

function idleRun(epoch) {
  return { status: 'idle', mode: null, guid: null, currentKey: null, message: '', error: '',
    epoch: epoch || 0, reloadList: false, nextAt: 0, startedAt: null, stats: {} };
}
function emptyState(epoch) {
  return { v: 1, fileName: '', loadedAt: null, rows: [], run: idleRun(epoch), log: [] };
}
async function loadState() {
  const d = await chrome.storage.local.get(KEY_STATE);
  return d[KEY_STATE] || emptyState(0);
}
async function getSettings() {
  const d = await chrome.storage.local.get(KEY_SETTINGS);
  return Object.assign({ autoSave: false }, d[KEY_SETTINGS]);
}
async function getRunTab() {
  const d = await chrome.storage.session.get(KEY_RUN_TAB);
  return d[KEY_RUN_TAB] || null;
}
async function setRunTab(v) {
  if (v) await chrome.storage.session.set({ [KEY_RUN_TAB]: v });
  else await chrome.storage.session.remove(KEY_RUN_TAB);
}

// כל שינוי במצב עובר בתור אחד, כדי שפקודות מהחלונית והריצה לא ידרסו זו את זו
let chain = Promise.resolve();
function mutate(fn) {
  const p = chain.then(async () => {
    const st = await loadState();
    const res = await fn(st);
    if (res !== SKIP_SAVE) await chrome.storage.local.set({ [KEY_STATE]: st });
    return res === SKIP_SAVE ? undefined : res;
  });
  chain = p.catch(() => {});
  return p;
}

let liveEpoch = -1; // משתנה בכל פקודה שמשנה את הריצה. שלב שרץ עם epoch ישן נעזב
function bump(s) { s.run.epoch = (s.run.epoch || 0) + 1; liveEpoch = s.run.epoch; }
function checkAbort(ctx) { if (ctx.epoch !== liveEpoch) throw new Abort(); }

// שינוי מצב מתוך שלב בריצה: רק אם הריצה עדיין אותה ריצה
function commit(ctx, fn) {
  return mutate(async s => {
    if (s.run.status !== 'running' || s.run.epoch !== ctx.epoch) throw new Abort();
    return fn(s);
  });
}

function addLog(s, msg) {
  s.log = s.log || [];
  s.log.push({ t: Date.now(), msg });
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}
const rowOf = (s, key) => s.rows.find(r => r.key === key);
const rowTitle = r => 'שורה ' + r.idx + ' (' + (r.n.label || r.raw.label || '') + ', ' + (r.n.date || r.raw.date) + ')';

function finishRow(s, r, status, notes, logText) {
  r.status = status;
  r.phase = null;
  r.notes = notes || [];
  if (status === 'done') r.doneAt = Date.now();
  delete r.beforeCount; delete r.marker; delete r.phaseAt; delete r.pendingVerify;
  s.run.currentKey = null;
  s.run.stats = s.run.stats || {};
  s.run.stats[status] = (s.run.stats[status] || 0) + 1;
  s.run.nextAt = Date.now() + C.TIMEOUTS.BETWEEN_ROWS_MS;
  addLog(s, rowTitle(r) + ': ' + (logText || T('STATUS_' + status)) + (notes && notes.length ? ' · ' + notes.join(' · ') : ''));
  if (s.run.mode === 'one') {
    s.run.status = 'idle';
    s.run.message = T('MSG_ONE_FINISHED', { idx: r.idx, status: T('STATUS_' + status) });
    bump(s);
  }
}

// השורה הנוכחית חוזרת להמתנה. אם כבר נשלחה שמירה (או שהמשתמש אולי לחץ "שמירה"),
// בפעם הבאה בודקים קודם ברשימה אם היא נשמרה (pendingVerify)
function releaseCurrent(s) {
  const r = s.run.currentKey ? rowOf(s, s.run.currentKey) : null;
  if (r && r.status === 'active') {
    if ((r.phase === 'saving' || r.phase === 'awaitSave') && r.beforeCount != null) r.pendingVerify = r.beforeCount;
    r.status = 'ready';
    r.phase = null;
    delete r.beforeCount; delete r.marker; delete r.phaseAt;
  }
  s.run.currentKey = null;
}

// ---------- הריצה ----------
let loopBusy = false;
let kickAgain = false;
function kick() {
  kickAgain = true;
  if (loopBusy) return;
  loopBusy = true;
  (async () => {
    try {
      while (kickAgain) { kickAgain = false; await runLoop(); }
    } catch (e) {
      console.error('runLoop', e);
    } finally {
      loopBusy = false;
    }
  })();
}

async function runLoop() {
  for (;;) {
    const st = await loadState();
    if (st.run.status !== 'running') return;
    liveEpoch = st.run.epoch;
    const tab = await getRunTab();
    const ctx = { epoch: st.run.epoch, tabId: tab && tab.tabId, guid: st.run.guid };
    if (!tab) { await failRun(ctx, new GeneralError(T('ERR_BROWSER_RESTART'))); return; }
    try {
      await step(ctx, st);
    } catch (e) {
      if (e instanceof Abort) continue;
      if (e instanceof RowError) {
        try { await rowFail(ctx, e.message); } catch (e2) { if (!(e2 instanceof Abort)) throw e2; }
        continue;
      }
      await failRun(ctx, e);
      return;
    }
  }
}

async function step(ctx, st) {
  let row = st.run.currentKey ? rowOf(st, st.run.currentKey) : null;
  if (row && row.status !== 'active') row = null;
  if (!row) {
    const next = st.rows.find(r => r.status === 'ready');
    if (!next) return finishRun(ctx);
    if (st.run.nextAt && Date.now() < st.run.nextAt) await sleepAbortable(ctx, st.run.nextAt - Date.now());
    return commit(ctx, s => {
      const r = rowOf(s, next.key);
      if (!r || r.status !== 'ready') return;
      r.status = 'active';
      r.phase = 'list';
      r.notes = [];
      s.run.currentKey = r.key;
      s.run.message = T('MSG_CHECK_DUP', { idx: r.idx });
    });
  }
  ctx.row = row;
  switch (row.phase) {
    case 'list': return phaseList(ctx, row);
    case 'form': return phaseForm(ctx, row);
    case 'saving': return phaseSaved(ctx, row, false);
    case 'awaitSave': return phaseSaved(ctx, row, true);
    default: return commit(ctx, s => { const r = rowOf(s, row.key); if (r) r.phase = 'list'; });
  }
}

// שלב 1: רשימת הפעילויות ובדיקת כפילות (תאריך + סוג + שם/נושא)
async function phaseList(ctx, row) {
  const st = await loadState();
  await openList(ctx, st.run.reloadList);
  const count = X.countMatches(await readActivities(ctx, row), row);
  await commit(ctx, s => {
    const r = rowOf(s, row.key);
    s.run.reloadList = false;
    if (r.pendingVerify != null) {
      const before = r.pendingVerify;
      delete r.pendingVerify;
      if (count === before + 1) {
        finishRow(s, r, 'done', r.force && before > 0 ? [T('NOTE_FORCED')] : [], 'נשמרה (זוהתה ברשימה)');
        return;
      }
    }
    if (count > 0 && !r.force) {
      finishRow(s, r, 'duplicate', [T('NOTE_DUPLICATE')]);
      return;
    }
    r.beforeCount = count;
    r.phase = 'form';
    s.run.message = T('MSG_FILLING', { idx: r.idx });
  });
}

// שלב 2: טופס חדש, בדיקת האפשרויות, מילוי, אימות, ושמירה (או המתנה לשמירה ידנית)
async function phaseForm(ctx, row) {
  await navigate(ctx, X.formUrl(ctx.guid), 'form');
  await assertLoggedIn(ctx);
  await waitPage(ctx, 'waitFormReady', C.TIMEOUTS.FORM_MS, 'ERR_FORM_TIMEOUT');
  const opts = await page(ctx, 'readFormOptions');
  const chk = X.checkOptions(row, opts);
  if (chk.error) throw new RowError(chk.error);
  const payload = X.formPayload(row, chk.nameOption);
  await page(ctx, 'fillForm', payload);
  const bad = X.verifyForm(payload, await page(ctx, 'readFormValues'));
  if (bad.length) throw new RowError(T('NOTE_FILL_MISMATCH', { fields: bad.join(', ') }));

  const { autoSave } = await getSettings();
  const token = await setMarker(ctx);
  if (!token) throw new GeneralError(T('ERR_PAGE_SCRIPT', { msg: 'marker' }));
  checkAbort(ctx);
  if (autoSave) {
    // קודם שומרים "saving", ורק אחר כך לוחצים: כך אחרי הפסקה לא תהיה שמירה כפולה
    await commit(ctx, s => {
      const r = rowOf(s, row.key);
      r.phase = 'saving'; r.marker = token; r.phaseAt = Date.now();
      s.run.message = T('MSG_SAVING', { idx: r.idx });
    });
    await page(ctx, 'clickSave');
  } else {
    await commit(ctx, s => {
      const r = rowOf(s, row.key);
      r.phase = 'awaitSave'; r.marker = token; r.phaseAt = Date.now();
      s.run.message = T('MSG_AWAIT_SAVE', { idx: r.idx });
    });
  }
}

// שלב 3: אחרי "שמירה": מחכים לרשימה, ומוודאים שנוספה בדיוק פעילות אחת תואמת
async function phaseSaved(ctx, row, manual) {
  const deadline = manual ? Infinity : (row.phaseAt || Date.now()) + C.TIMEOUTS.SAVE_MS;
  let marker = row.marker;
  for (;;) {
    checkAbort(ctx);
    const tab = await getTab(ctx);
    if (tab.status === 'complete' && tab.url) {
      const route = X.routeOf(tab.url, ctx.guid);
      if (route === 'list') break; // חזרנו לרשימה
      if (route === 'foreign' || route === null) throw new GeneralError(T('ERR_TAB_LEFT'));
      if (route === 'other') {
        await assertLoggedIn(ctx);
        throw new GeneralError(T('ERR_UNEXPECTED_PAGE', { path: X.pathOf(tab.url) }));
      }
      // עדיין בטופס. אם זה מסמך חדש, הטופס נטען מחדש (שגיאת אימות או רענון)
      if (marker == null || await isNewDocument(ctx, marker)) {
        if (!manual) {
          const errs = await safePage(ctx, 'readFormErrors');
          throw new RowError(T('NOTE_SAVE_FAILED', { errors: errs ? ': ' + errs : '' }));
        }
        // ידני: ממשיכים לחכות, על המסמך החדש
        const mk = await setMarker(ctx);
        if (mk) {
          marker = mk;
          await commit(ctx, s => {
            const r = rowOf(s, row.key);
            r.marker = mk;
            s.run.message = T('MSG_FORM_RELOADED', { idx: r.idx });
          });
        }
      }
    }
    if (Date.now() > deadline) {
      const errs = await safePage(ctx, 'readFormErrors');
      throw new RowError(T('NOTE_SAVE_NOT_DONE', { errors: errs ? ': ' + errs : '' }));
    }
    await sleepAbortable(ctx, C.TIMEOUTS.POLL_MS);
  }

  await commit(ctx, s => { s.run.message = T('MSG_VERIFYING', { idx: row.idx }); });
  await assertLoggedIn(ctx);
  await waitPage(ctx, 'waitListReady', C.TIMEOUTS.TABLE_MS, 'ERR_TABLE_TIMEOUT');
  const count = X.countMatches(await readActivities(ctx, row), row);
  const before = row.beforeCount || 0;
  if (count !== before + 1) {
    throw new RowError(T('NOTE_SAVE_NOT_VERIFIED', { count, expected: before + 1 }));
  }
  await commit(ctx, s => {
    const r = rowOf(s, row.key);
    finishRow(s, r, 'done', r.force && before > 0 ? [T('NOTE_FORCED')] : []);
  });
}

async function rowFail(ctx, msg) {
  await commit(ctx, s => {
    const r = s.run.currentKey ? rowOf(s, s.run.currentKey) : null;
    if (r && r.status === 'active') finishRow(s, r, 'error', [msg]);
  });
}

async function finishRun(ctx) {
  await commit(ctx, s => {
    const st = s.run.stats || {};
    s.run.status = 'idle';
    s.run.currentKey = null;
    s.run.message = T('MSG_FINISHED', { done: st.done || 0, duplicate: st.duplicate || 0, error: st.error || 0, skipped: st.skipped || 0 });
    addLog(s, s.run.message);
    bump(s);
  });
  await setRunTab(null);
}

async function failRun(ctx, e) {
  const msg = e instanceof GeneralError ? e.message : T('ERR_INTERNAL', { msg: (e && e.message) || String(e) });
  if (!(e instanceof GeneralError)) console.error(e);
  await mutate(s => {
    if (s.run.status !== 'running' || s.run.epoch !== ctx.epoch) return SKIP_SAVE;
    releaseCurrent(s);
    s.run.status = 'error';
    s.run.error = msg;
    s.run.message = '';
    addLog(s, 'הריצה נעצרה: ' + msg);
    bump(s);
  });
}

// ---------- הלשונית והדף ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function sleepAbortable(ctx, ms) {
  const end = Date.now() + ms;
  for (;;) {
    checkAbort(ctx);
    const left = end - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(C.TIMEOUTS.POLL_MS, left));
  }
}

async function getTab(ctx) {
  let tab;
  try { tab = await chrome.tabs.get(ctx.tabId); } catch (e) { tab = null; }
  checkAbort(ctx);
  if (!tab) throw new GeneralError(T('ERR_TAB_CLOSED'));
  return tab;
}

async function execMain(ctx, opts) {
  return chrome.scripting.executeScript(Object.assign({ target: { tabId: ctx.tabId }, world: 'MAIN' }, opts));
}

// סימון במסמך הנוכחי. אחרי ניווט, מסמך חדש לא מכיל אותו, וכך יודעים שהדף באמת נטען מחדש
async function setMarker(ctx) {
  const token = 'tip-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  try {
    await execMain(ctx, { func: tk => { window.__tipNav = tk; }, args: [token] });
    return token;
  } catch (e) {
    return null;
  }
}
async function isNewDocument(ctx, token) {
  try {
    const res = await execMain(ctx, { func: tk => window.__tipNav !== tk, args: [token] });
    return !!(res && res[0] && res[0].result === true);
  } catch (e) {
    return false; // הדף באמצע טעינה
  }
}

async function navigate(ctx, url, expect) {
  checkAbort(ctx);
  const from = await getTab(ctx);
  const fromRoute = X.routeOf(from.url, ctx.guid);
  // טופס שמולא ולא נשמר (בעיה בשורה או "דלג"): לא לתת לדף לעצור את היציאה בחלון "לצאת מהאתר?"
  if (fromRoute === 'form') await safePage(ctx, 'allowLeave');
  const token = await setMarker(ctx);
  try { await chrome.tabs.update(ctx.tabId, { url }); } catch (e) { throw new GeneralError(T('ERR_TAB_CLOSED')); }
  const started = Date.now();
  const deadline = started + C.TIMEOUTS.NAV_MS;
  let sawLoading = false;
  for (;;) {
    await sleepAbortable(ctx, C.TIMEOUTS.POLL_MS);
    const tab = await getTab(ctx);
    if (tab.status !== 'complete') sawLoading = true;
    if (tab.status === 'complete' && tab.url) {
      const route = X.routeOf(tab.url, ctx.guid);
      const fresh = (route === expect && fromRoute !== expect) ||
        (token ? await isNewDocument(ctx, token) : (sawLoading || Date.now() - started > 1500));
      if (fresh) {
        if (route === expect) return tab;
        if (route === 'foreign' || route === null) throw new GeneralError(T('ERR_TAB_LEFT'));
        await assertLoggedIn(ctx);
        throw new GeneralError(T('ERR_UNEXPECTED_PAGE', { path: X.pathOf(tab.url) }));
      }
    }
    if (Date.now() > deadline) throw new GeneralError(T('ERR_PAGE_TIMEOUT', { s: Math.round(C.TIMEOUTS.NAV_MS / 1000) }));
  }
}

async function openList(ctx, forceReload) {
  const tab = await getTab(ctx);
  const route = X.routeOf(tab.url, ctx.guid);
  if (route === 'foreign' || route === null) throw new GeneralError(T('ERR_TAB_LEFT'));
  if (forceReload || route !== 'list' || tab.status !== 'complete') await navigate(ctx, X.listUrl(ctx.guid), 'list');
  await assertLoggedIn(ctx);
  await waitPage(ctx, 'waitListReady', C.TIMEOUTS.TABLE_MS, 'ERR_TABLE_TIMEOUT');
}

async function readActivities(ctx, row) {
  const res = await page(ctx, 'readActivities', row.n.date);
  if (!res || !Array.isArray(res.items) || res.complete === false) throw new GeneralError(T('ERR_LIST_INCOMPLETE'));
  return res.items;
}

async function assertLoggedIn(ctx) {
  const pr = await page(ctx, 'probe');
  if (pr && pr.login) throw new GeneralError(T('ERR_LOGGED_OUT'));
}

// קריאות חוזרות לפונקציית המתנה בדף, כל אחת קצרה, עד שהיא מחזירה true או שנגמר הזמן
async function waitPage(ctx, fn, totalMs, errKey) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    const left = deadline - Date.now();
    const ok = await page(ctx, fn, Math.max(200, Math.min(C.TIMEOUTS.PAGE_CALL_MS, left)));
    if (ok === true) return;
    if (Date.now() >= deadline) throw new GeneralError(T(errKey, { s: Math.round(totalMs / 1000) }));
  }
}

function pageConfig() {
  return { selectors: C.SELECTORS, timeouts: C.TIMEOUTS, version: C.VERSION };
}

async function injectPage(ctx) {
  try {
    const res = await execMain(ctx, {
      func: v => !!(window.__tipulogExt && window.__tipulogExt.version === v),
      args: [C.VERSION],
    });
    if (res && res[0] && res[0].result) return;
    await execMain(ctx, { files: ['page.js'] });
  } catch (e) {
    throw new GeneralError(T('ERR_PAGE_SCRIPT', { msg: (e && e.message) || String(e) }));
  }
}

// רצה בתוך הדף (MAIN world). חייבת להיות עצמאית, בלי משתנים מבחוץ
async function pageCall(fn, args) {
  const api = window.__tipulogExt;
  if (!api || typeof api[fn] !== 'function') return { ok: false, code: 'NO_API', error: 'page.js: ' + fn };
  try {
    return { ok: true, value: await api[fn].apply(api, args) };
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'ERR', error: String((e && e.message) || e) };
  }
}

async function page(ctx, fn, ...args) {
  checkAbort(ctx);
  await injectPage(ctx);
  checkAbort(ctx);
  let res;
  try {
    res = await execMain(ctx, { func: pageCall, args: [fn, [pageConfig()].concat(args)] });
  } catch (e) {
    throw new GeneralError(T('ERR_PAGE_SCRIPT', { msg: (e && e.message) || String(e) }));
  }
  checkAbort(ctx);
  const r = res && res[0] && res[0].result;
  if (!r) throw new GeneralError(T('ERR_PAGE_SCRIPT', { msg: fn }));
  if (!r.ok) {
    if (r.code === 'ROW') throw new RowError(r.error);
    if (r.code === 'NOT_CAPTURED') throw new GeneralError(T('ERR_NOT_CAPTURED_FN', { fn: r.error }));
    throw new GeneralError(r.error);
  }
  return r.value;
}

async function safePage(ctx, fn) {
  try { return await page(ctx, fn); } catch (e) { if (e instanceof Abort) throw e; return null; }
}

// ---------- פקודות מהחלונית ----------
async function handle(msg) {
  switch (msg && msg.cmd) {
    case 'ping': {
      const st = await loadState();
      if (st.run.status === 'running') kick();
      return {};
    }
    case 'load': return cmdLoad(msg);
    case 'start': return cmdStart(msg);
    case 'stop': return cmdStop();
    case 'skip': return cmdSkip();
    case 'force': return cmdForce(msg);
    case 'reset': return cmdReset();
    case 'setAutoSave': {
      const cur = await getSettings();
      await chrome.storage.local.set({ [KEY_SETTINGS]: Object.assign(cur, { autoSave: !!msg.value }) });
      return {};
    }
    default: throw new Error('פקודה לא מוכרת');
  }
}

async function cmdLoad(msg) {
  const rows = X.loadRows(String(msg.text || ''));
  return mutate(s => {
    if (s.run.status === 'running') throw new Error(T('ERR_BUSY'));
    const { kept } = X.mergeRows(s.rows, rows);
    s.rows = rows;
    s.fileName = msg.fileName || '';
    s.loadedAt = Date.now();
    s.run = idleRun(s.run.epoch);
    bump(s);
    const c = X.counts(rows);
    addLog(s, 'נטען ' + (s.fileName || 'קובץ') + ': ' + c.total + ' שורות, ' + c.ready + ' ממתינות' + (kept ? ', ' + kept + ' כבר דווחו בריצה קודמת' : ''));
    return { counts: c, kept };
  });
}

async function cmdStart(msg) {
  if (!C.CAPTURED) throw new Error(T('ERR_NOT_CAPTURED'));
  let tab = null;
  try { tab = await chrome.tabs.get(msg.tabId); } catch (e) { tab = null; }
  const guid = tab && X.guidFrom(tab.url);
  if (!guid) throw new Error(T('ERR_NO_TAB'));
  await mutate(async s => {
    if (s.run.status === 'running') throw new Error(T('ERR_ALREADY_RUNNING'));
    releaseCurrent(s);
    s.rows.forEach(r => { if (r.status === 'active') { r.status = 'ready'; r.phase = null; } });
    if (!s.rows.some(r => r.status === 'ready')) throw new Error(T('ERR_NOTHING_READY'));
    await setRunTab({ tabId: tab.id, windowId: tab.windowId });
    s.run = Object.assign(idleRun(s.run.epoch), {
      status: 'running', mode: msg.mode === 'one' ? 'one' : 'all', guid,
      startedAt: Date.now(), reloadList: true, message: T('MSG_STARTING'),
    });
    bump(s);
    const { autoSave } = await getSettings();
    addLog(s, (s.run.mode === 'one' ? 'הבא (שורה אחת)' : 'התחל') + ', שמירה אוטומטית: ' + (autoSave ? 'דלוקה' : 'כבויה'));
  });
  kick();
  return {};
}

async function cmdStop() {
  await mutate(s => {
    if (s.run.status === 'error') { s.run.status = 'idle'; s.run.error = ''; return; }
    if (s.run.status !== 'running') return SKIP_SAVE;
    releaseCurrent(s);
    s.run.status = 'idle';
    s.run.message = T('MSG_STOPPED');
    addLog(s, 'נעצר על ידי המשתמש');
    bump(s);
  });
  await setRunTab(null);
  return {};
}

async function cmdSkip() {
  await mutate(s => {
    const r = s.run.status === 'running' && s.run.currentKey ? rowOf(s, s.run.currentKey) : null;
    if (!r || r.status !== 'active') throw new Error(T('ERR_NOTHING_TO_SKIP'));
    if (r.phase === 'saving') throw new Error(T('ERR_SAVE_IN_PROGRESS'));
    finishRow(s, r, 'skipped', [T('NOTE_SKIPPED')]);
    if (s.run.status === 'running') bump(s);
  });
  kick();
  return {};
}

async function cmdForce(msg) {
  await mutate(s => {
    const r = rowOf(s, msg.key);
    if (!r || r.status !== 'duplicate') throw new Error(T('ERR_NO_ROW'));
    r.status = 'ready';
    r.force = true;
    r.notes = [];
    addLog(s, rowTitle(r) + ': "הזן בכל זאת"');
  });
  return {};
}

async function cmdReset() {
  await mutate(async s => {
    if (s.run.status === 'running') throw new Error(T('ERR_BUSY'));
    const epoch = (s.run.epoch || 0) + 1;
    await chrome.storage.local.clear();
    Object.keys(s).forEach(k => delete s[k]);
    Object.assign(s, emptyState(epoch));
    liveEpoch = epoch;
  });
  await setRunTab(null);
  return {};
}

// ---------- אירועים (נרשמים מיד, ברמה העליונה) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg).then(
    res => sendResponse(Object.assign({ ok: true }, res)),
    err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

// ניווט בלשונית (למשל אחרי "שמירה") מעיר את ה-service worker וממשיך ריצה פעילה
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') resumeIfRunning();
});

async function resumeIfRunning() {
  try {
    const st = await loadState();
    if (st.run.status === 'running') kick();
  } catch (e) { console.error(e); }
}

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(e => console.error(e));
}
resumeIfRunning();

// לבדיקות ב-Node בלבד
if (globalThis.__TIP_TEST__) {
  globalThis.__tipBg = { handle, kick, loadState, getSettings, busy: () => loopBusy };
}
