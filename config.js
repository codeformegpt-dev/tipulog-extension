/* config.js: כתובות, זמני המתנה, טקסטים וסלקטורים.
   נטען בחלונית (script), ב-service worker (importScripts) וב-Node (בדיקות).
   SELECTORS נלקחו מהלכידה (list.txt, form.txt). לא ממציאים סלקטורים. */
(function (root) {
  'use strict';

  const CONFIG = {
    VERSION: '0.2.0',

    // הסלקטורים הושלמו לפי הלכידה; ניתן להריץ בדיקות מתוך חלונית התוסף.
    CAPTURED: true,

    BASE_URL: 'https://app.cliniclicks.com/leshanot',
    ROUTES: {
      list: '/supervisor/activities/',          // + <guid> של העובד
      form: '/supervisor/newemployeeactivity/', // + <guid> של העובד
    },
    GUID_PATTERN: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',

    TIMEOUTS: {
      NAV_MS: 20000,         // טעינת דף בלשונית
      TABLE_MS: 20000,       // טבלת הפעילויות
      FORM_MS: 15000,        // רכיבי הטופס
      SAVE_MS: 30000,        // מ"שמירה" ועד שהרשימה חוזרת (במצב אוטומטי)
      BETWEEN_ROWS_MS: 1500, // הפסקה בין שורות
      POLL_MS: 300,
      PAGE_CALL_MS: 4000,    // המתנה מקסימלית בתוך קריאה אחת לדף
    },

    // מהלכידה של שני מסכי טיפולוג. page.js מקבל אותם בכל קריאה.
    SELECTORS: {
      list: {
        grid: '#items',
        searchStart: '#SearchForm_StartDate',
        searchFilters: ['#SearchForm_FreeText', '#SearchForm_Type', '#SearchForm_Location', '#SearchForm_EndDate'],
        fields: { date: 'ActivityDate', type: 'Type', label: 'Field1' },
      },
      form: {
        form: '#editform',
        radios: 'input[name="EmployeeActivity.IsFrontal"]',
        onlineValue: 'אונליין',
        frontalValue: 'פרונטלי',
        type: '#EmployeeActivity_Type',
        date: '#EmployeeActivity_ActivityDate',
        start: '#EmployeeActivity_ActivityHour',
        end: '#EmployeeActivity_ActivityEndHour',
        name: '#EmployeeActivity_Supervisor',
        duration: '#EmployeeActivity_ActivityTimeInMinutes',
        label: '#EmployeeActivity_Field1',
        extraInfo: '#EmployeeActivity_Field2',
        description: '#EmployeeActivity_Description',
        saveButton: '#editform button[type="submit"].btn-primary',
        saveText: 'שמירה',
        errors: '.field-validation-error, .validation-summary-errors li, .k-notification-content',
      },
    },

    TEXT: {
      // סטטוס של שורה
      STATUS_ready: 'ממתינה',
      STATUS_active: 'בטיפול',
      STATUS_done: 'דווחה',
      STATUS_csvDone: 'דווחה קודם',
      STATUS_duplicate: 'כבר קיימת',
      STATUS_error: 'בעיה',
      STATUS_skipped: 'דולגה',
      STATUS_notReady: 'לא מוכנה',

      // למה שורה לא מוכנה
      REASON_DONE: 'כבר דווח (done? = TRUE)',
      REASON_NOTES: 'יש הערות בעמודה notes',
      REASON_NO_DATE: 'אין תאריך',
      REASON_BAD_DATE: 'תאריך לא תקין: {v}',
      REASON_NO_TIME: 'חסרה {col}',
      REASON_BAD_TIME: '{col} לא תקינה: {v}',
      REASON_TIME_ORDER: 'שעת הסיום לא אחרי שעת ההתחלה',
      REASON_NO_TYPE: 'אין סוג פעילות',
      REASON_BAD_BOOL: 'ערך לא תקין בעמודה {col}: {v}',
      REASON_COLUMNS: 'מספר עמודות שגוי ({n} במקום {expected})',

      // הערות שנכתבות בקובץ הפלט
      NOTE_NO_NAME: '{label} בלי שם. משאיר ריק',
      NOTE_ONLINE_EMPTY: 'online? ריק. דווח כאונליין',
      NOTE_DUPLICATE: 'כבר קיים בטיפולוג',
      NOTE_FORCED: 'הוזן בכל זאת (היה קיים בטיפולוג)',
      NOTE_TYPE_NOT_FOUND: 'סוג הפעילות לא נמצא בטיפולוג: {type}',
      NOTE_NAME_NOT_FOUND: 'השם לא נמצא ברשימת המודרכים: {name}',
      NOTE_NAME_AMBIGUOUS: 'יש יותר ממודרך אחד בשם {name}',
      NOTE_TIME_NOT_IN_LIST: 'השעה {time} לא קיימת ברשימת השעות',
      NOTE_LABEL_TOO_LONG: 'שם/נושא ארוך מדי ({length} תווים; המקסימום בטיפולוג הוא {max})',
      NOTE_FILL_MISMATCH: 'ערך לא נקלט בטופס: {fields}',
      NOTE_SAVE_FAILED: 'השמירה נכשלה והטופס נשאר פתוח{errors}',
      NOTE_SAVE_NOT_DONE: 'השמירה לא הושלמה: הטופס לא חזר לרשימה{errors}',
      NOTE_SAVE_NOT_VERIFIED: 'השמירה לא אומתה: ברשימה {count} פעילויות תואמות, ציפיתי ל-{expected}',
      NOTE_SKIPPED: 'דולג ידנית',

      // מצב הריצה
      MSG_STARTING: 'מתחיל…',
      MSG_CHECK_DUP: 'שורה {idx}: בודק אם הפעילות כבר קיימת…',
      MSG_FILLING: 'שורה {idx}: ממלא את הטופס…',
      MSG_SAVING: 'שורה {idx}: שומר…',
      MSG_AWAIT_SAVE: 'שורה {idx}: הטופס מלא. בדוק ולחץ "שמירה" בטיפולוג, או "דלג"',
      MSG_FORM_RELOADED: 'שורה {idx}: הטופס נטען מחדש. מלא ושמור בעצמך, או לחץ "דלג"',
      MSG_VERIFYING: 'שורה {idx}: מוודא ברשימה…',
      MSG_STOPPED: 'נעצר',
      MSG_ONE_FINISHED: 'שורה {idx}: {status}. לשורה הבאה לחץ "הבא"',
      MSG_FINISHED: 'הסתיים. דווחו: {done}, כבר קיימות: {duplicate}, בעיות: {error}, דולגו: {skipped}',

      // תקלות כלליות (עוצרות את הריצה) ושגיאות בפקודות
      ERR_NOT_CAPTURED: 'התוסף עוד לא הושלם: חסרים פרטי המסך של טיפולוג (שלב ב׳)',
      ERR_NOT_CAPTURED_FN: 'חסר בקוד, ימולא אחרי הלכידה: {fn}',
      ERR_NO_TAB: 'פתח בלשונית הפעילה את מסך "פעילויות" של המנהלת בטיפולוג, ונסה שוב',
      ERR_ALREADY_RUNNING: 'הריצה כבר פועלת',
      ERR_NOTHING_READY: 'אין שורות ממתינות',
      ERR_NOTHING_TO_SKIP: 'אין שורה בטיפול',
      ERR_SAVE_IN_PROGRESS: 'השמירה כבר נשלחה. חכה כמה שניות',
      ERR_BUSY: 'קודם לחץ "עצור"',
      ERR_NO_ROW: 'השורה לא נמצאה',
      ERR_TAB_CLOSED: 'הלשונית של טיפולוג נסגרה',
      ERR_TAB_LEFT: 'הלשונית כבר לא בטיפולוג (אולי התנתקת)',
      ERR_LOGGED_OUT: 'נראה שהתנתקת מטיפולוג. התחבר מחדש ולחץ "התחל"',
      ERR_UNEXPECTED_PAGE: 'נפתח בטיפולוג דף לא צפוי: {path}',
      ERR_PAGE_TIMEOUT: 'הדף בטיפולוג לא נטען תוך {s} שניות',
      ERR_TABLE_TIMEOUT: 'טבלת הפעילויות לא נטענה תוך {s} שניות',
      ERR_FORM_TIMEOUT: 'טופס ההוספה לא נטען תוך {s} שניות',
      ERR_LIST_INCOMPLETE: 'לא הצלחתי לקרוא את כל הפעילויות הקיימות, ולכן אין בדיקת כפילות',
      ERR_PAGE_SCRIPT: 'תקלה בהרצת קוד בדף טיפולוג: {msg}',
      ERR_BROWSER_RESTART: 'הדפדפן נסגר באמצע הריצה. פתח את מסך הפעילויות ולחץ "התחל" כדי להמשיך',
      ERR_INTERNAL: 'תקלה פנימית בתוסף: {msg}',

      // קריאת ה-CSV
      ERR_CSV_EMPTY: 'הקובץ ריק',
      ERR_CSV_QUOTE: 'מירכאות לא סגורות, החל משורה {line} בקובץ',
      ERR_CSV_HEADERS: 'הכותרות בקובץ לא תואמות. צפוי: {expected} | בקובץ: {got}',
      ERR_CSV_NOROWS: 'אין שורות נתונים בקובץ',
    },
  };

  root.TIP_CONFIG = CONFIG;
  if (typeof module === 'object' && module.exports) module.exports = CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
