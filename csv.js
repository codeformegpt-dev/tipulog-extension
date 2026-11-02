/* csv.js: קריאת ה-CSV, בדיקת השורות ונרמול, מיזוג עם מצב קודם, בדיקות מול הטופס וכתיבת קובץ הפלט.
   קוד טהור: בלי DOM ובלי chrome.*. נטען בחלונית, ב-service worker וב-Node (בדיקות).
   הטקסטים מגיעים מ-config.js (TIP_CONFIG.TEXT). */
(function (root) {
  'use strict';

  const HEADERS = ['name', 'date', 'start_time', 'end_time', 'online?', 'type', 'label', 'description', 'done?', 'notes'];
  const NOTE_SEP = ' | ';

  // ---------- טקסטים ----------
  function fmt(tpl, vars) {
    return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
  }
  function t(key, vars) {
    const all = (root.TIP_CONFIG && root.TIP_CONFIG.TEXT) || {};
    return all[key] == null ? key : fmt(all[key], vars);
  }

  // ---------- נרמול ----------
  const pad2 = n => String(n).padStart(2, '0');
  function normSpaces(s) { return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim(); }
  function normText(s) { return String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim(); }

  // d/M/yyyy או dd/MM/yyyy ← dd/MM/yyyy. תאריך לא קיים (31/02) ← null
  function parseDate(s) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    const d = +m[1], mo = +m[2], y = +m[3];
    if (mo < 1 || mo > 12 || d < 1) return null;
    if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
    return pad2(d) + '/' + pad2(mo) + '/' + y;
  }

  // H:mm או HH:mm (וגם HH:mm:00) ← HH:mm
  function parseTime(s) {
    const m = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return pad2(h) + ':' + pad2(mi);
  }
  function toMinutes(hhmm) { const p = hhmm.split(':'); return (+p[0]) * 60 + (+p[1]); }

  // TRUE / FALSE / ריק (בלי תלות באותיות גדולות)
  function parseBool(s) {
    const v = String(s == null ? '' : s).trim().toUpperCase();
    if (v === '') return { empty: true, value: null };
    if (v === 'TRUE') return { value: true };
    if (v === 'FALSE') return { value: false };
    return { invalid: true, value: null };
  }

  // ---------- קריאת CSV (RFC 4180) ----------
  // מחזיר [{ line, fields }] בלי רשומות ריקות. תומך ב-BOM, CRLF/LF, פסיקים, ירידות שורה ו-"" בתוך מירכאות.
  function parseCSV(input) {
    let s = String(input == null ? '' : input);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    const records = [];
    let rec = [], field = '', inQ = false, quoted = false;
    let line = 1, recLine = 1, i = 0;
    const n = s.length;
    const endField = () => { rec.push(field); field = ''; quoted = false; };
    const endRecord = () => { endField(); records.push({ line: recLine, fields: rec }); rec = []; };
    while (i < n) {
      const c = s[i];
      if (inQ) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        if (c === '\n') line++;
        field += c; i++; continue;
      }
      if (c === '"' && field === '' && !quoted) { inQ = true; quoted = true; i++; continue; }
      if (c === ',') { endField(); i++; continue; }
      if (c === '\r' || c === '\n') {
        endRecord();
        if (c === '\r' && s[i + 1] === '\n') i++;
        i++; line++; recLine = line;
        continue;
      }
      field += c; i++;
    }
    if (inQ) throw new Error(t('ERR_CSV_QUOTE', { line: recLine }));
    if (field !== '' || rec.length || quoted) endRecord();
    return records.filter(r => r.fields.some(f => f !== ''));
  }

  // בודק את הכותרות ומחזיר רשומות עם raw לפי שם העמודה
  function readTable(text) {
    const recs = parseCSV(text);
    if (!recs.length) throw new Error(t('ERR_CSV_EMPTY'));
    const header = recs[0].fields.map(h => h.trim());
    while (header.length > HEADERS.length && header[header.length - 1] === '') header.pop();
    if (header.length !== HEADERS.length || header.some((h, i) => h !== HEADERS[i])) {
      throw new Error(t('ERR_CSV_HEADERS', { expected: HEADERS.join(','), got: header.join(',') }));
    }
    const rows = recs.slice(1).map(r => {
      let f = r.fields.slice();
      let bad = f.length < HEADERS.length;
      if (f.length > HEADERS.length) {
        if (f.slice(HEADERS.length).every(x => x.trim() === '')) f = f.slice(0, HEADERS.length);
        else bad = true;
      }
      const raw = {};
      HEADERS.forEach((h, k) => { raw[h] = f[k] == null ? '' : f[k]; });
      return { line: r.line, raw, fieldCount: r.fields.length, badColumns: bad };
    });
    if (!rows.length) throw new Error(t('ERR_CSV_NOROWS'));
    return rows;
  }

  // ---------- בדיקת שורה ----------
  // status: ready | notReady | csvDone. בהמשך: active | done | duplicate | error | skipped
  // reasons: למה לא מוכנה ({text, out}: out=true נכתב לפלט). info: הערות שנכתבות לפלט רק אם השורה דווחה.
  function evaluateRow(rec, idx) {
    const raw = rec.raw;
    const n = {
      name: normSpaces(raw.name),
      type: raw.type.trim(),
      label: raw.label.trim(),
      description: normText(raw.description),
      date: null, start: null, end: null, duration: null, online: true,
    };
    const reasons = [], info = [];
    const done = parseBool(raw['done?']);
    const online = parseBool(raw['online?']);
    n.online = online.value !== false; // ריק או TRUE = אונליין

    if (rec.badColumns) reasons.push({ text: t('REASON_COLUMNS', { n: rec.fieldCount, expected: HEADERS.length }), out: true });
    if (done.invalid) reasons.push({ text: t('REASON_BAD_BOOL', { col: 'done?', v: raw['done?'].trim() }), out: true });
    if (raw.notes.trim() !== '') reasons.push({ text: t('REASON_NOTES'), out: false });

    const dateStr = raw.date.trim();
    if (!dateStr) reasons.push({ text: t('REASON_NO_DATE'), out: false });
    else {
      n.date = parseDate(dateStr);
      if (!n.date) reasons.push({ text: t('REASON_BAD_DATE', { v: dateStr }), out: true });
    }
    [['start_time', 'start', 'שעת התחלה'], ['end_time', 'end', 'שעת סיום']].forEach(([col, key, title]) => {
      const v = raw[col].trim();
      if (!v) reasons.push({ text: t('REASON_NO_TIME', { col: title }), out: true });
      else {
        n[key] = parseTime(v);
        if (!n[key]) reasons.push({ text: t('REASON_BAD_TIME', { col: title, v }), out: true });
      }
    });
    if (n.start && n.end) {
      n.duration = toMinutes(n.end) - toMinutes(n.start);
      if (n.duration <= 0) reasons.push({ text: t('REASON_TIME_ORDER'), out: true });
    }
    if (!n.type) reasons.push({ text: t('REASON_NO_TYPE'), out: true });
    if (online.invalid) reasons.push({ text: t('REASON_BAD_BOOL', { col: 'online?', v: raw['online?'].trim() }), out: true });

    let status;
    if (done.value === true) {
      status = 'csvDone';
      reasons.length = 0;
      reasons.push({ text: t('REASON_DONE'), out: false });
    } else {
      status = reasons.length ? 'notReady' : 'ready';
      if (!n.name) info.push(t('NOTE_NO_NAME', { label: n.label || n.type }));
      if (online.empty) info.push(t('NOTE_ONLINE_EMPTY'));
    }
    return { idx, line: rec.line, key: '', raw, n, status, reasons, info, notes: [] };
  }

  // המפתח: date|start_time|end_time|name|type|label (אחרי נרמול)
  function rowKey(r) {
    const n = r.n, raw = r.raw;
    return [n.date || raw.date.trim(), n.start || raw.start_time.trim(), n.end || raw.end_time.trim(),
      n.name, n.type, n.label].join('|');
  }

  function loadRows(text) {
    const seen = new Map();
    return readTable(text).map((rec, i) => {
      const r = evaluateRow(rec, i + 1);
      let k = rowKey(r);
      const c = (seen.get(k) || 0) + 1;
      seen.set(k, c);
      if (c > 1) k += '#' + c;
      r.key = k;
      return r;
    });
  }

  // CSV חדש: שורה שכבר נשמרה בטיפולוג (done) נשארת done. כל השאר נבדקות מחדש.
  function mergeRows(oldRows, newRows) {
    const old = new Map((oldRows || []).map(r => [r.key, r]));
    let kept = 0;
    newRows.forEach(r => {
      const o = old.get(r.key);
      if (o && o.status === 'done' && r.status !== 'csvDone') {
        r.status = 'done';
        r.notes = (o.notes || []).slice();
        r.info = (o.info || []).slice();
        r.doneAt = o.doneAt;
        kept++;
      }
    });
    return { rows: newRows, kept };
  }

  function counts(rows) {
    const c = { total: 0, ready: 0, active: 0, done: 0, csvDone: 0, duplicate: 0, error: 0, skipped: 0, notReady: 0 };
    (rows || []).forEach(r => { c.total++; c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }

  // ---------- מול טיפולוג ----------
  // כמה פעילויות קיימות עם אותו תאריך, סוג ושם/נושא
  function countMatches(items, row) {
    const n = row.n, label = normSpaces(n.label);
    return (items || []).filter(a => a &&
      parseDate(a.date) === n.date &&
      String(a.type == null ? '' : a.type).trim() === n.type &&
      normSpaces(a.label) === label).length;
  }

  // בדיקת סוג, מודרך ושעות מול האפשרויות שבטופס. מחזיר { error } או { nameOption }
  function checkOptions(row, opts) {
    const n = row.n;
    const labelMax = opts && Number(opts.labelMax);
    if (Number.isSafeInteger(labelMax) && labelMax > 0 && n.label.length > labelMax) {
      return { error: t('NOTE_LABEL_TOO_LONG', { length: n.label.length, max: labelMax }) };
    }
    const types = ((opts && opts.types) || []).map(x => String(x == null ? '' : x).trim());
    if (!types.includes(n.type)) return { error: t('NOTE_TYPE_NOT_FOUND', { type: n.type }) };
    let nameOption = '';
    if (n.name) {
      const found = ((opts && opts.names) || []).filter(x => normSpaces(x) === n.name);
      if (!found.length) return { error: t('NOTE_NAME_NOT_FOUND', { name: n.name }) };
      if (found.length > 1) return { error: t('NOTE_NAME_AMBIGUOUS', { name: n.name }) };
      nameOption = found[0];
    }
    const lists = [[n.start, opts && (opts.startTimes || opts.times)], [n.end, opts && (opts.endTimes || opts.times)]];
    for (const [time, list] of lists) {
      if (Array.isArray(list) && list.length && !list.map(parseTime).includes(time)) {
        return { error: t('NOTE_TIME_NOT_IN_LIST', { time }) };
      }
    }
    return { nameOption };
  }

  // מה ממלאים בטופס (מקום הפעילות ומידע נוסף לא נוגעים)
  function formPayload(row, nameOption) {
    const n = row.n;
    return {
      online: n.online, type: n.type, date: n.date, start: n.start, end: n.end,
      name: nameOption || '', label: n.label, description: n.description, duration: n.duration,
    };
  }

  // השוואת הערכים שנקראו מהטופס לערכים הצפויים. מחזיר רשימת שדות שלא נקלטו
  function verifyForm(p, got) {
    const bad = [];
    const g = got || {};
    const s = v => String(v == null ? '' : v);
    if (g.online !== p.online) bad.push('פרונטלי/אונליין');
    if (s(g.type).trim() !== p.type) bad.push('סוג פעילות');
    if (parseDate(g.date) !== p.date) bad.push('תאריך התחלה');
    if (parseTime(g.start) !== p.start) bad.push('שעת התחלה');
    if (parseTime(g.end) !== p.end) bad.push('שעת סיום');
    if (normSpaces(g.name) !== normSpaces(p.name)) bad.push('מודרך/ת');
    if (g.duration == null || g.duration === '' || Number(g.duration) !== p.duration) {
      bad.push('משך פעילות (' + (g.duration == null || g.duration === '' ? 'ריק' : g.duration) + ' במקום ' + p.duration + ')');
    }
    if (s(g.label).trim() !== p.label) bad.push('שם/נושא');
    if (normText(g.description) !== normText(p.description)) bad.push('תיאור הפעילות');
    if (g.extraInfo != null && s(g.extraInfo).trim() !== '') bad.push('מידע נוסף (צריך להישאר ריק)');
    return bad;
  }

  // ---------- כתובות בטיפולוג ----------
  const cfg = () => root.TIP_CONFIG;
  const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function parseUrl(url) { try { return new URL(url); } catch (e) { return null; } }
  function basePath() { return new URL(cfg().BASE_URL).pathname.replace(/\/+$/, ''); }
  function guidFrom(url) {
    const u = parseUrl(url);
    if (!u || u.origin !== new URL(cfg().BASE_URL).origin) return null;
    const R = cfg().ROUTES;
    const re = new RegExp('^' + escRe(basePath()) + '(?:' + escRe(R.list) + '|' + escRe(R.form) + ')(' + cfg().GUID_PATTERN + ')/?$', 'i');
    const m = re.exec(u.pathname);
    return m ? m[1] : null;
  }
  // 'list' | 'form' | 'other' (דף אחר בטיפולוג) | 'foreign' (אתר אחר) | null (אין כתובת)
  function routeOf(url, guid) {
    const u = parseUrl(url);
    if (!u) return null;
    if (u.origin !== new URL(cfg().BASE_URL).origin) return 'foreign';
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    const g = String(guid || '').toLowerCase();
    const R = cfg().ROUTES;
    if (g && path === (basePath() + R.list + g).toLowerCase()) return 'list';
    if (g && path === (basePath() + R.form + g).toLowerCase()) return 'form';
    return 'other';
  }
  function pathOf(url) { const u = parseUrl(url); return u ? u.pathname : String(url || ''); }
  function listUrl(guid) { return cfg().BASE_URL + cfg().ROUTES.list + guid; }
  function formUrl(guid) { return cfg().BASE_URL + cfg().ROUTES.form + guid; }

  // ---------- קובץ הפלט ----------
  function outputNotes(r) {
    switch (r.status) {
      case 'done': return (r.info || []).concat(r.notes || []);
      case 'duplicate': case 'error': case 'skipped': return (r.notes || []).slice();
      case 'notReady': case 'csvDone': return (r.reasons || []).filter(x => x.out).map(x => x.text);
      default: return [];
    }
  }
  function csvField(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // אותו מבנה ואותו סדר שורות, UTF-8 עם BOM. done? מעודכן, ו-notes = ההערות המקוריות | הערות התוסף
  function buildOutput(rows) {
    const lines = [HEADERS.map(csvField).join(',')];
    (rows || []).forEach(r => {
      const raw = Object.assign({}, r.raw);
      if (r.status === 'done') raw['done?'] = 'TRUE';
      const parts = [];
      if (String(raw.notes || '').trim() !== '') parts.push(raw.notes);
      outputNotes(r).forEach(x => parts.push(x));
      raw.notes = parts.join(NOTE_SEP);
      lines.push(HEADERS.map(h => csvField(raw[h])).join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
  function outputFileName(fileName) {
    const base = String(fileName || 'tipulog').replace(/\.csv$/i, '') || 'tipulog';
    return base + '-פלט.csv';
  }

  const api = {
    HEADERS, NOTE_SEP, fmt, t, normSpaces, normText, parseDate, parseTime, toMinutes, parseBool,
    parseCSV, readTable, evaluateRow, rowKey, loadRows, mergeRows, counts,
    countMatches, checkOptions, formPayload, verifyForm,
    guidFrom, routeOf, pathOf, listUrl, formUrl,
    outputNotes, csvField, buildOutput, outputFileName,
  };
  root.TipCSV = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
