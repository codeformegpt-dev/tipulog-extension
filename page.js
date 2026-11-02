/* page.js: פונקציות שרצות בתוך דף טיפולוג (MAIN world). background.js מזריק את הקובץ
   ואז קורא לפונקציות דרך chrome.scripting.executeScript({ world: 'MAIN' }).
   כל פונקציה מקבלת cfg = { selectors, timeouts, version } מ-config.js.
   המבנה לפי הלכידה (02/11/2026): Kendo UI 2021.1.119 ו-jQuery 1.12.4.
     רשימה: Grid ב-table#items. הנתונים בדפים בשרת (30 בעמוד), ולכן הפעילויות נקראות ישר מהשרת
            דרך ה-DataSource של הטבלה, בלי לדפדף ובלי לשנות את מה שמוצג.
     טופס:  form#editform. סוג פעילות = select רגיל. תאריך = DatePicker. שעות = TimePicker (כל 15 דקות).
            מודרך/ת = DropDownList. "שמירה" = button[type=submit] (שליחה רגילה של הטופס). לא נוגעים ב"אפס".

   הממשק (מה ש-background.js מצפה לקבל):
     probe(cfg)                     → { path, login, kendo, jquery, ready }
     allowLeave(cfg)                → true. מבטל חלון "לצאת מהאתר?" לפני ניווט מטופס שלא נשמר
     waitListReady(cfg, ms)         → true כשהטבלה מוכנה, false אם עבר הזמן
     readActivities(cfg, onDate)    → { items: [{ date: 'dd/MM/yyyy', type, label }], total, complete }
     waitFormReady(cfg, ms)         → true כשהטופס מוכן, false אם עבר הזמן
     readFormOptions(cfg)           → { types, names, startTimes, endTimes, labelMax }
     fillForm(cfg, p)               → true. p = { online, type, date, start, end, name, label, description, duration }
     readFormValues(cfg)            → { online, type, date, start, end, name, duration, label, description, extraInfo }
     clickSave(cfg)                 → true. בודק את הטופס ולוחץ "שמירה" בלבד
     readFormErrors(cfg)            → טקסט הודעות השגיאה בטופס, או null

   שגיאות: PageError עם code:
     'ROW'       בעיה בשורה (הערה ודילוג)
     'SELECTOR'  רכיב לא נמצא (תקלה כללית, עוצרת)
     'FILTER'    סינון פעיל ברשימה שמונע בדיקת כפילות (תקלה כללית, עוצרת)
     'SERVER'    שגיאה בקריאת הפעילויות מהשרת (תקלה כללית, עוצרת) */
(() => {
  'use strict';
  const VERSION = '0.2.0'; // חייב להיות זהה ל-VERSION ב-config.js
  if (window.__tipulogExt && window.__tipulogExt.version === VERSION) return;

  class PageError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const rowError = msg => new PageError('ROW', msg);
  const selectorError = what => new PageError('SELECTOR', 'רכיב לא נמצא בדף: ' + what);

  // ---------- עזרים ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad2 = n => String(n).padStart(2, '0');
  const normSpaces = s => String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim();
  const jq = () => window.jQuery;

  async function waitUntil(fn, ms, every = 150) {
    const end = Date.now() + (ms || 0);
    for (;;) {
      let ok = false;
      try { ok = !!(await fn()); } catch (e) { ok = false; }
      if (ok) return true;
      if (Date.now() >= end) return false;
      await sleep(every);
    }
  }
  function withTimeout(promise, ms, err) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(err), ms);
      promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
  }

  // Date, '/Date(ms)/', 'yyyy-MM-dd...', 'd/M/yyyy' ← 'dd/MM/yyyy'
  function toDateStr(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : pad2(v.getDate()) + '/' + pad2(v.getMonth() + 1) + '/' + v.getFullYear();
    const s = String(v).trim();
    let m = /^\/Date\((-?\d+)/.exec(s);
    if (m) return toDateStr(new Date(+m[1]));
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[3] + '/' + m[2] + '/' + m[1];
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return pad2(m[1]) + '/' + pad2(m[2]) + '/' + m[3];
    return null;
  }
  // Date, 'H:mm', 'HH:mm:ss' ← 'HH:mm'
  function toTimeStr(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : pad2(v.getHours()) + ':' + pad2(v.getMinutes());
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v).trim());
    return m && +m[1] < 24 && +m[2] < 60 ? pad2(m[1]) + ':' + m[2] : null;
  }
  const dateKey = ddmmyyyy => { const p = ddmmyyyy.split('/'); return p[2] + p[1] + p[0]; };

  function q(selector, what) {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) throw selectorError(what || selector || '(סלקטור חסר)');
    return el;
  }
  const isVisible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  function widget(el, name) {
    const $ = jq();
    return $ && el ? $(el).data(name) || null : null;
  }
  // אירוע רגיל של הדפדפן: מפעיל גם את מה שהדף רשם ב-jQuery
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

  // הצבת ערך בשדה רגיל, כך שהדף "ירגיש" שינוי (input + change)
  function setNative(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    fire(el, 'input');
    fire(el, 'change');
  }

  // ---------- רשימת הפעילויות ----------
  function gridOf(cfg) {
    return widget(document.querySelector(cfg.selectors.list.grid), 'kendoGrid');
  }

  // קריאה אחת מהשרת, באותה דרך שהטבלה קוראת (כולל הפרמטרים של החיפוש), בלי לשנות את התצוגה
  function transportRead(ds, params) {
    return new Promise((resolve, reject) => {
      ds.transport.read({
        data: params,
        success: resolve,
        error: xhr => reject(new PageError('SERVER', 'שגיאה בקריאת רשימת הפעילויות מהשרת' + (xhr && xhr.status ? ' (' + xhr.status + ')' : ''))),
      });
    });
  }

  async function readAllViaTransport(ds, mapItem) {
    const size = 500;
    const sort = ds.sort() && ds.sort().length ? ds.sort() : [{ field: 'Id', dir: 'desc' }];
    const items = [];
    let total = NaN;
    for (let page = 1; page <= 40; page++) {
      const params = { page, pageSize: size, skip: (page - 1) * size, take: size, sort, _ts: Date.now() };
      const resp = await withTimeout(transportRead(ds, params), 25000, new PageError('SERVER', 'השרת לא ענה בזמן לקריאת רשימת הפעילויות'));
      const parsed = ds.reader.parse(resp);
      const errors = ds.reader.errors ? ds.reader.errors(parsed) : null;
      if (errors) throw new PageError('SERVER', 'השרת החזיר שגיאה ברשימת הפעילויות');
      const data = ds.reader.data(parsed) || [];
      total = Number(ds.reader.total(parsed));
      for (let i = 0; i < data.length; i++) items.push(mapItem(data[i]));
      if (!data.length || !(items.length < total)) break;
    }
    return { items, total, complete: Number.isFinite(total) && items.length >= total };
  }

  // גיבוי: query של ה-DataSource עם עמוד אחד גדול (משנה את מה שהטבלה מציגה)
  async function readAllViaQuery(ds, mapItem) {
    const size = Math.max(ds.total() || 0, 30) + 30;
    await withTimeout(Promise.resolve(ds.query({ page: 1, pageSize: size, sort: ds.sort() })), 30000,
      new PageError('SERVER', 'השרת לא ענה בזמן לקריאת רשימת הפעילויות'));
    const data = ds.data();
    const items = [];
    for (let i = 0; i < data.length; i++) items.push(mapItem(data[i]));
    return { items, total: ds.total(), complete: items.length >= ds.total() };
  }

  // ---------- טופס ההוספה ----------
  function form(cfg) { return cfg.selectors.form; }

  // כל רשימת השעות של TimePicker (לפי interval, min ו-max)
  function timeList(tp) {
    const o = tp && tp.options;
    const step = o && Number(o.interval);
    if (!step) return null;
    const minM = o.min instanceof Date ? o.min.getHours() * 60 + o.min.getMinutes() : 0;
    let maxM = o.max instanceof Date ? o.max.getHours() * 60 + o.max.getMinutes() : 0;
    if (maxM <= minM) maxM += 24 * 60; // min = max: כל היממה
    const out = [];
    for (let m = minM; m <= maxM && out.length < 24 * 60; m += step) {
      const mm = m % (24 * 60);
      const s = pad2(Math.floor(mm / 60)) + ':' + pad2(mm % 60);
      if (!out.includes(s)) out.push(s);
    }
    return out;
  }

  function setDate(el, ddmmyyyy) {
    const dp = widget(el, 'kendoDatePicker');
    if (!dp) throw selectorError('לוח השנה של תאריך ההתחלה');
    const mk = widget(el, 'kendoMaskedTextBox');
    const p = ddmmyyyy.split('/').map(Number);
    if (mk) mk.value(ddmmyyyy);
    dp.value(new Date(p[2], p[1] - 1, p[0]));
    fire(el, 'change');
  }

  function setTime(el, hhmm, what) {
    const tp = widget(el, 'kendoTimePicker');
    if (!tp) throw selectorError('רשימת השעות של ' + what);
    const mk = widget(el, 'kendoMaskedTextBox');
    const p = hhmm.split(':').map(Number);
    const d = tp.options.min instanceof Date ? new Date(tp.options.min.getTime()) : new Date();
    d.setHours(p[0], p[1], 0, 0);
    if (mk) mk.value(hhmm);
    tp.value(d);
    fire(el, 'change'); // בשעת הסיום: הדף מחשב מזה את משך הפעילות
  }

  function readTime(el) {
    const tp = widget(el, 'kendoTimePicker');
    const shown = toTimeStr(el.value);
    if (!tp || !tp.value() || toTimeStr(tp.value()) !== shown) return null;
    return shown;
  }

  function readErrors(cfg) {
    const seen = [];
    document.querySelectorAll(form(cfg).errors).forEach(el => {
      const t = normSpaces(el.textContent);
      if (t && isVisible(el) && !seen.includes(t)) seen.push(t);
    });
    return seen.length ? seen.join(' · ').slice(0, 300) : null;
  }

  // ---------- הממשק ----------
  const api = {
    version: VERSION,

    probe() {
      return {
        path: location.pathname,
        login: !!document.querySelector('input[type="password"]'),
        kendo: !!window.kendo,
        jquery: !!window.jQuery,
        ready: document.readyState,
      };
    },

    allowLeave() {
      window.onbeforeunload = null;
      if (!window.__tipLeaveGuard) {
        window.__tipLeaveGuard = true;
        window.addEventListener('beforeunload', e => { e.stopImmediatePropagation(); }, true);
      }
      return true;
    },

    // הטבלה מוכנה כשרכיב ה-Grid וה-DataSource שלו קיימים
    waitListReady(cfg, ms) {
      return waitUntil(() => {
        const g = gridOf(cfg);
        return !!(g && g.dataSource && g.dataSource.transport && g.dataSource.reader);
      }, ms);
    },

    // כל הפעילויות הקיימות של העובד, ישר מהשרת. onDate: התאריך של השורה (לבדיקת סינון החיפוש)
    async readActivities(cfg, onDate) {
      const s = cfg.selectors.list;
      for (const sel of s.searchFilters || []) {
        const el = document.querySelector(sel);
        if (el && normSpaces(el.value)) {
          throw new PageError('FILTER', 'יש סינון בחיפוש של רשימת הפעילויות. נקה את שדות החיפוש, טען את הרשימה מחדש ונסה שוב');
        }
      }
      const startEl = document.querySelector(s.searchStart);
      const from = startEl ? toDateStr(startEl.value) : null;
      if (from && onDate && dateKey(from) > dateKey(onDate)) {
        throw new PageError('FILTER', 'בחיפוש של רשימת הפעילויות מוגדר "תאריך התחלה" ' + from + ', מאוחר מ-' + onDate + '. הקדם אותו, טען את הרשימה מחדש ונסה שוב');
      }
      const g = gridOf(cfg);
      if (!g || !g.dataSource) throw selectorError('טבלת הפעילויות');
      const ds = g.dataSource;
      const f = s.fields;
      const mapItem = r => ({
        date: toDateStr(r[f.date]),
        type: normSpaces(r[f.type]),
        label: r[f.label] == null ? '' : String(r[f.label]),
      });
      let res;
      try {
        res = await readAllViaTransport(ds, mapItem);
      } catch (e) {
        if (e instanceof PageError) throw e;
        res = await readAllViaQuery(ds, mapItem); // מבנה פנימי לא צפוי: גיבוי דרך הטבלה עצמה
      }
      return res;
    },

    // הטופס מוכן כשכל הרכיבים קיימים, וגם עברה כשנייה מטעינת הדף:
    // הדף רושם את חישוב "משך פעילות" משעת הסיום רק חצי שנייה אחרי שהוא נטען
    waitFormReady(cfg, ms) {
      const s = form(cfg);
      return waitUntil(() => {
        if (!document.querySelector(s.form)) return false;
        const ready = widget(document.querySelector(s.date), 'kendoDatePicker') &&
          widget(document.querySelector(s.start), 'kendoTimePicker') &&
          widget(document.querySelector(s.end), 'kendoTimePicker') &&
          widget(document.querySelector(s.name), 'kendoDropDownList') &&
          document.querySelector(s.type) && document.querySelector(s.label) &&
          document.querySelector(s.description) && document.querySelector(s.duration);
        if (!ready) return false;
        const nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
        const readyAt = nav && nav.domContentLoadedEventEnd;
        return !readyAt || performance.now() - readyAt > 900;
      }, ms);
    },

    readFormOptions(cfg) {
      const s = form(cfg);
      const typeSel = q(s.type, 'סוג פעילות');
      const types = Array.from(typeSel.options).map(o => normSpaces(o.text)).filter(Boolean);
      const dd = widget(q(s.name, 'מודרך/ת'), 'kendoDropDownList');
      if (!dd) throw selectorError('הרשימה של מודרך/ת');
      const tf = dd.options.dataTextField || 'text';
      const names = dd.dataSource.data().map(i => (i == null ? '' : String(i[tf] == null ? '' : i[tf]))).filter(x => normSpaces(x) !== '');
      const label = q(s.label, 'שם/נושא');
      return {
        types,
        names,
        startTimes: timeList(widget(q(s.start, 'שעת התחלה'), 'kendoTimePicker')),
        endTimes: timeList(widget(q(s.end, 'שעת סיום'), 'kendoTimePicker')),
        labelMax: label.maxLength > 0 ? label.maxLength : null,
      };
    },

    // הסדר חשוב: סוג (הדף מאפס את המשך לברירת המחדל), תאריך, התחלה, סיום (הדף מחשב משך), מודרך, טקסטים
    async fillForm(cfg, p) {
      const s = form(cfg);
      // פרונטלי / אונליין
      const want = p.online ? s.onlineValue : s.frontalValue;
      const radio = Array.from(document.querySelectorAll(s.radios)).find(r => r.value === want);
      if (!radio) throw selectorError('פרונטלי/אונליין');
      if (!radio.checked) radio.click();

      // סוג פעילות
      const typeSel = q(s.type, 'סוג פעילות');
      const opt = Array.from(typeSel.options).find(o => normSpaces(o.text) === p.type);
      if (!opt) throw rowError('סוג הפעילות לא נמצא בטיפולוג: ' + p.type);
      typeSel.value = opt.value;
      fire(typeSel, 'change');

      // תאריך ושעות
      setDate(q(s.date, 'תאריך התחלה'), p.date);
      setTime(q(s.start, 'שעת התחלה'), p.start, 'שעת ההתחלה');
      setTime(q(s.end, 'שעת סיום'), p.end, 'שעת הסיום');

      // מודרך/ת (ריק = האפשרות הריקה)
      const nameEl = q(s.name, 'מודרך/ת');
      const dd = widget(nameEl, 'kendoDropDownList');
      if (!dd) throw selectorError('הרשימה של מודרך/ת');
      const tf = dd.options.dataTextField || 'text', vf = dd.options.dataValueField || 'value';
      if (p.name) {
        const item = dd.dataSource.data().find(i => i && normSpaces(i[tf]) === normSpaces(p.name));
        if (!item) throw rowError('השם לא נמצא ברשימת המודרכים: ' + p.name);
        dd.value(item[vf]);
      } else {
        dd.value('');
      }
      dd.trigger('change');
      fire(nameEl, 'change');

      // שם/נושא ותיאור. "מידע נוסף" ו"מקום הפעילות" לא נוגעים
      setNative(q(s.label, 'שם/נושא'), p.label);
      const desc = q(s.description, 'תיאור הפעילות');
      setNative(desc, p.description);
      if (typeof window.textAreaAdjust === 'function') { try { window.textAreaAdjust(desc); } catch (e) { /* תצוגה בלבד */ } }

      // משך פעילות: הדף מחשב אותו משעת הסיום. אם לא חושב, מציבים את ההפרש בעצמנו
      await sleep(50);
      const dur = q(s.duration, 'משך פעילות');
      if (dur.value.trim() !== String(p.duration)) setNative(dur, String(p.duration));
      return true;
    },

    readFormValues(cfg) {
      const s = form(cfg);
      const radio = Array.from(document.querySelectorAll(s.radios)).find(r => r.checked);
      const typeSel = q(s.type, 'סוג פעילות');
      const dateEl = q(s.date, 'תאריך התחלה');
      const dp = widget(dateEl, 'kendoDatePicker');
      const shownDate = toDateStr(dateEl.value);
      const dd = widget(q(s.name, 'מודרך/ת'), 'kendoDropDownList');
      return {
        online: radio ? radio.value === s.onlineValue : null,
        type: typeSel.selectedIndex >= 0 ? normSpaces(typeSel.options[typeSel.selectedIndex].text) : '',
        date: dp && dp.value() && toDateStr(dp.value()) === shownDate ? shownDate : null,
        start: readTime(q(s.start, 'שעת התחלה')),
        end: readTime(q(s.end, 'שעת סיום')),
        name: dd ? normSpaces(dd.text()) : null,
        duration: q(s.duration, 'משך פעילות').value.trim(),
        label: q(s.label, 'שם/נושא').value,
        description: q(s.description, 'תיאור הפעילות').value,
        extraInfo: q(s.extraInfo, 'מידע נוסף').value,
      };
    },

    // בודק את הטופס (כמו שהדף בודק לפני שליחה), ואז לוחץ "שמירה". אף פעם לא "אפס"
    clickSave(cfg) {
      const s = form(cfg);
      const f = q(s.form, 'הטופס');
      const btn = Array.from(document.querySelectorAll(s.saveButton))
        .find(b => b.type === 'submit' && b.form === f && normSpaces(b.textContent) === s.saveText);
      if (!btn) throw selectorError('הכפתור "שמירה"');
      const $ = jq();
      if ($ && $.fn && typeof $.fn.valid === 'function') {
        let valid = true;
        try { valid = $(f).valid(); } catch (e) { valid = true; }
        if (!valid) throw rowError('הטופס לא עבר את הבדיקה של טיפולוג: ' + (readErrors(cfg) || 'שדה לא תקין'));
      }
      setTimeout(() => btn.click(), 50); // הקריאה חוזרת לפני שהדף מתחיל לנווט
      return true;
    },

    readFormErrors(cfg) {
      return readErrors(cfg);
    },
  };

  api._helpers = { PageError, waitUntil, toDateStr, toTimeStr, setNative, timeList, widget, normSpaces };
  window.__tipulogExt = api;
})();
