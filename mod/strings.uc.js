// @ts-check
// Zen Peek — every piece of text the mod shows, per language. To add a
// language, copy the `en` table, translate the values (keep the {names}),
// and add it to `TABLES`. Missing keys fall back to English.
/* exported ZPStrings */
// eslint-disable-next-line no-var
var ZPStrings = (() => {
  "use strict";

  /** @type {Record<string, string>} */
  const en = {
    "gmail.title": "Gmail",
    "gmail.empty": "Inbox zero 🎉",
    "gmail.no-subject": "(no subject)",
    "gmail.unknown-sender": "(unknown)",
    "unread": "{n} unread",
    "cal.empty": "Nothing today",
    "cal.next": "Next",
    "cal.all-day": "All day",
    "cal.now": "now",
    "cal.soon": "in {n} min",
    "cal.no-title": "(no title)",
    "cal.join": "Join",
    "cal.join-label": "Join on {provider}",
    "gh.title": "GitHub",
    "gh.reviews": "Review requested · {n}",
    "gh.mine": "Your pull requests",
    "gh.notifications": "Notifications",
    "gh.empty": "No unread notifications",
    "gh.all-off": "All GitHub sections are turned off in Zen Peek's settings",
    "gh.status.draft": "draft",
    "gh.status.approved": "approved",
    "gh.status.changes requested": "changes requested",
    "gh.status.waiting for review": "waiting for review",
    "gh.ci.passing": "Checks passing",
    "gh.ci.failing": "Checks failing",
    "gh.ci.running": "Checks running",
    "hn.title": "Hacker News · Top",
    "hn.comments": "{n} comments",
    "page.not-loaded": "{host} · not loaded",
    "error.setup.calendar": "Add your calendar's secret iCal address in Zen Peek's settings.",
    "error.setup.github": "Set a GitHub token to see your pull requests and notifications.",
    "error.signed-out": "Sign in to this account in Zen to see it here.",
    "error.auth": "Access was refused. Check the address or token.",
    "error.network": "Couldn't connect. Are you offline?",
    "error.timeout": "The service didn't answer in time.",
    "error.rate-limited": "Too many requests for now. Trying again at {time}.",
    "error.server": "The service returned an error. Try again soon.",
    "error.parse": "That address didn't return a calendar.",
    "error.unknown": "Couldn't load this preview.",
    "button.set-calendar": "Set calendar address…",
    "button.set-github": "Set GitHub token…",
    "button.retry": "Try again",
    "menu.set-calendar": "Zen Peek: set calendar address…",
    "menu.set-github": "Zen Peek: set GitHub token…",
    "prompt.calendar":
      "Paste your calendar's secret address in iCal format.\n\nGoogle Calendar → Settings → your calendar → Integrate calendar → " +
      "\"Secret address in iCal format\". For several calendars, separate addresses with spaces.\n\nIt's stored in Zen's password manager.",
    "prompt.github":
      "Paste a GitHub personal access token with the \"notifications\" scope (github.com → Settings → Developer settings → Tokens (classic)).\n\n" +
      "It's stored in Zen's password manager.",
    "a11y.preview": "Preview: {name}",
    "a11y.badge": "{n} unread",
    "a11y.badge-dot": "Unread",
  };

  /** @type {Record<string, string>} */
  const tr = {
    "gmail.title": "Gmail",
    "gmail.empty": "Gelen kutusu boş 🎉",
    "gmail.no-subject": "(konu yok)",
    "gmail.unknown-sender": "(bilinmiyor)",
    "unread": "{n} okunmamış",
    "cal.empty": "Bugün bir şey yok",
    "cal.next": "Sıradaki",
    "cal.all-day": "Tüm gün",
    "cal.now": "şimdi",
    "cal.soon": "{n} dk sonra",
    "cal.no-title": "(başlıksız)",
    "cal.join": "Katıl",
    "cal.join-label": "{provider} ile katıl",
    "gh.title": "GitHub",
    "gh.reviews": "İnceleme bekleyen · {n}",
    "gh.mine": "Pull request'lerin",
    "gh.notifications": "Bildirimler",
    "gh.empty": "Okunmamış bildirim yok",
    "gh.all-off": "Tüm GitHub bölümleri Zen Peek ayarlarında kapalı",
    "gh.status.draft": "taslak",
    "gh.status.approved": "onaylandı",
    "gh.status.changes requested": "değişiklik istendi",
    "gh.status.waiting for review": "inceleme bekliyor",
    "gh.ci.passing": "Kontroller geçti",
    "gh.ci.failing": "Kontroller başarısız",
    "gh.ci.running": "Kontroller çalışıyor",
    "hn.title": "Hacker News · Gündem",
    "hn.comments": "{n} yorum",
    "page.not-loaded": "{host} · yüklenmedi",
    "error.setup.calendar": "Zen Peek ayarlarından takviminin gizli iCal adresini ekle.",
    "error.setup.github": "Pull request'lerini ve bildirimlerini görmek için bir GitHub token'ı ekle.",
    "error.signed-out": "Burada görmek için Zen'de bu hesaba giriş yap.",
    "error.auth": "Erişim reddedildi. Adresi veya token'ı kontrol et.",
    "error.network": "Bağlanılamadı. Çevrimdışı mısın?",
    "error.timeout": "Servis zamanında yanıt vermedi.",
    "error.rate-limited": "Şimdilik çok fazla istek yapıldı. {time} itibarıyla tekrar denenecek.",
    "error.server": "Servis bir hata döndürdü. Birazdan tekrar dene.",
    "error.parse": "Bu adres bir takvim döndürmedi.",
    "error.unknown": "Bu önizleme yüklenemedi.",
    "button.set-calendar": "Takvim adresini ayarla…",
    "button.set-github": "GitHub token'ı ayarla…",
    "button.retry": "Tekrar dene",
    "menu.set-calendar": "Zen Peek: takvim adresini ayarla…",
    "menu.set-github": "Zen Peek: GitHub token'ı ayarla…",
    "prompt.calendar":
      "Takviminin iCal biçimindeki gizli adresini yapıştır.\n\nGoogle Takvim → Ayarlar → takvimin → Takvimi entegre et → " +
      "\"iCal biçimindeki gizli adres\". Birden fazla takvim için adresleri boşlukla ayır.\n\nZen'in parola yöneticisinde saklanır.",
    "prompt.github":
      "\"notifications\" izni olan bir GitHub kişisel erişim token'ı yapıştır (github.com → Settings → Developer settings → Tokens (classic)).\n\n" +
      "Zen'in parola yöneticisinde saklanır.",
    "a11y.preview": "Önizleme: {name}",
    "a11y.badge": "{n} okunmamış",
    "a11y.badge-dot": "Okunmamış",
  };

  const TABLES = { en, tr };
  let current = "en";

  // "tr-TR" → "tr"; anything without a table → "en".
  const pick = (locale) => {
    const base = String(locale || "").toLowerCase().split(/[-_]/)[0];
    return Object.hasOwn(TABLES, base) ? base : "en";
  };

  return {
    /** Switches language; returns the one actually used. */
    use(locale) {
      current = pick(locale);
      return current;
    },
    get locale() {
      return current;
    },
    /** Text for `key`, with {name} placeholders filled from `vars`. */
    t(key, vars = {}) {
      const s = TABLES[current][key] ?? en[key] ?? key;
      return s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
    },
    languages: Object.keys(TABLES),
    tables: TABLES,
  };
})();
