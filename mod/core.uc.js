// Zen Peek — pure logic: which card a site gets, feed/calendar parsing,
// recurring events, time zones, formatting. No browser APIs here.
// eslint-disable-next-line no-var
var ZPCore = (() => {
  "use strict";

  // --- Which card for which site -------------------------------------------------

  function cardFor(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^www\./, "");
    if (host === "mail.google.com") {
      const m = u.pathname.match(/\/mail\/u\/(\d+)/);
      return { type: "gmail", account: m ? Number(m[1]) : 0 };
    }
    if (host === "calendar.google.com") return { type: "calendar" };
    if (host === "github.com") return { type: "github" };
    if (host === "news.ycombinator.com") return { type: "hn" };
    return null;
  }

  // --- XML / entities --------------------------------------------------------------

  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  function decode(s) {
    return String(s || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === "#") {
          const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(n) ? String.fromCodePoint(n) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
      })
      .trim();
  }
  const tag = (xml, name) => {
    const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    return m ? decode(m[1]) : "";
  };

  // Gmail's Atom feed of unread mail (mail.google.com/mail/u/N/feed/atom).
  function parseGmailAtom(xml) {
    if (!/<feed[\s>]/i.test(xml)) throw new Error("not a Gmail feed (signed out?)");
    const fullcount = Number(tag(xml, "fullcount")) || 0;
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => {
      const e = m[1];
      const author = (e.match(/<author>([\s\S]*?)<\/author>/i) || [])[1] || "";
      const link = (e.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
      return {
        subject: tag(e, "title") || "(no subject)",
        snippet: tag(e, "summary"),
        from: tag(author, "name") || tag(author, "email"),
        date: new Date(tag(e, "issued") || tag(e, "modified")),
        url: decode(link),
      };
    });
    return { unread: fullcount, mails: entries };
  }

  // --- Time zones ------------------------------------------------------------------

  // UTC offset (ms) of a time zone at a given instant.
  function tzOffset(tz, date) {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
  }

  // Wall-clock time in a zone → Date.
  function zoned(y, mo, d, h, mi, s, tz) {
    const guess = Date.UTC(y, mo, d, h, mi, s);
    let t = guess - tzOffset(tz, new Date(guess));
    t = guess - tzOffset(tz, new Date(t)); // settle across DST changes
    return new Date(t);
  }

  function validTz(tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  // --- iCalendar ---------------------------------------------------------------------

  // Parses a DTSTART/DTEND style property into { date, allDay }.
  function parseIcsDate(value, params, defaultTz) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    if (h === undefined) return { date: new Date(+y, +mo - 1, +d), allDay: true };
    if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
    const tz = params.TZID && validTz(params.TZID) ? params.TZID : defaultTz;
    if (tz) return { date: zoned(+y, +mo - 1, +d, +h, +mi, +s, tz), allDay: false };
    return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false }; // floating
  }

  function parseICS(text) {
    const lines = String(text).replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
    if (!lines.some((l) => l.startsWith("BEGIN:VCALENDAR"))) throw new Error("not an iCalendar file");
    let calTz = "";
    const events = [];
    let ev = null;
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") {
        ev = { exdates: [] };
        continue;
      }
      if (line === "END:VEVENT") {
        if (ev._start) events.push(ev);
        ev = null;
        continue;
      }
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [name, ...paramParts] = line.slice(0, i).split(";");
      const params = Object.fromEntries(paramParts.map((p) => p.split("=")).map(([k, v]) => [k.toUpperCase(), (v || "").replace(/^"|"$/g, "")]));
      const value = line.slice(i + 1);
      if (!ev) {
        if (name === "X-WR-TIMEZONE") calTz = validTz(value) ? value : "";
        continue;
      }
      const text = () => value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
      switch (name.toUpperCase()) {
        case "SUMMARY": ev.summary = text(); break;
        case "LOCATION": ev.location = text(); break;
        case "UID": ev.uid = value; break;
        case "STATUS": ev.status = value; break;
        case "URL": ev.url = value; break;
        case "RRULE": ev.rrule = Object.fromEntries(value.split(";").map((p) => p.split("="))); break;
        case "DTSTART": Object.assign(ev, { _start: [value, params] }); break;
        case "DTEND": ev._end = [value, params]; break;
        case "DURATION": ev.duration = value; break;
        case "RECURRENCE-ID": ev._rid = [value, params]; break;
        case "EXDATE": for (const v of value.split(",")) ev.exdates.push([v, params]); break;
      }
    }
    // Resolve dates now that the calendar's default zone is known.
    for (const e of events) {
      const s = parseIcsDate(...e._start, calTz);
      if (!s) continue;
      e.start = s.date;
      e.allDay = s.allDay;
      const en = e._end ? parseIcsDate(...e._end, calTz) : null;
      e.end = en ? en.date : new Date(s.date.getTime() + (e.duration ? durationMs(e.duration) : s.allDay ? 86400000 : 0));
      if (e._rid) e.recurrenceId = parseIcsDate(...e._rid, calTz)?.date;
      e.exdates = e.exdates.map((x) => parseIcsDate(...x, calTz)?.date?.getTime()).filter(Boolean);
      if (e.rrule?.UNTIL) e.until = parseIcsDate(e.rrule.UNTIL, {}, calTz)?.date;
      delete e._start;
      delete e._end;
      delete e._rid;
    }
    return events.filter((e) => e.start instanceof Date && !isNaN(e.start));
  }

  function durationMs(d) {
    const m = d.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!m) return 0;
    const [, w, dd, h, mi, s] = m.map((x) => Number(x) || 0);
    return ((((w * 7 + dd) * 24 + h) * 60 + mi) * 60 + s) * 1000;
  }

  const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

  // Start times of an event's occurrences that begin before `until` (Date).
  // Supports DAILY / WEEKLY (BYDAY) / MONTHLY (BYMONTHDAY) / YEARLY with
  // INTERVAL, COUNT and UNTIL, which covers what calendars export in practice.
  function occurrences(ev, until) {
    const out = [];
    const r = ev.rrule;
    if (!r) return ev.start < until ? [ev.start] : [];
    const interval = Math.max(1, Number(r.INTERVAL) || 1);
    const count = Number(r.COUNT) || Infinity;
    const stop = ev.until && ev.until < until ? new Date(ev.until.getTime() + 1) : until;
    const s = ev.start;
    const h = s.getHours(), mi = s.getMinutes(), se = s.getSeconds();
    let n = 0;
    const push = (d) => {
      if (d < s) return true;
      if (d >= stop || n >= count) return false;
      n++;
      if (!ev.exdates.includes(d.getTime())) out.push(d);
      return true;
    };
    const at = (y, mo, d) => new Date(y, mo, d, h, mi, se);
    for (let i = 0; i < 20000; i++) {
      if (r.FREQ === "DAILY") {
        if (!push(at(s.getFullYear(), s.getMonth(), s.getDate() + i * interval))) break;
      } else if (r.FREQ === "WEEKLY") {
        const byday = r.BYDAY ? r.BYDAY.split(",").map((x) => DAYS.indexOf(x.slice(-2))) : [s.getDay()];
        const weekStart = at(s.getFullYear(), s.getMonth(), s.getDate() - s.getDay() + i * 7 * interval);
        let go = true;
        for (const wd of [...byday].sort((a, b) => a - b)) {
          go = push(at(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + wd));
          if (!go) break;
        }
        if (!go) break;
      } else if (r.FREQ === "MONTHLY") {
        const day = Number(r.BYMONTHDAY) || s.getDate();
        const d = at(s.getFullYear(), s.getMonth() + i * interval, day);
        if (d.getDate() !== day) continue; // e.g. the 31st in a 30-day month
        if (!push(d)) break;
      } else if (r.FREQ === "YEARLY") {
        if (!push(at(s.getFullYear() + i * interval, s.getMonth(), s.getDate()))) break;
      } else {
        push(s);
        break;
      }
      if (n >= count) break;
    }
    return out;
  }

  // Events overlapping the local day that contains `day`, sorted, with
  // single-instance changes (RECURRENCE-ID) replacing their series instance.
  function eventsOnDay(events, day = new Date()) {
    const from = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const overrides = new Map();
    for (const e of events) if (e.recurrenceId && e.uid) overrides.set(`${e.uid}|${e.recurrenceId.getTime()}`, e);
    const out = [];
    for (const e of events) {
      if (e.recurrenceId || e.status === "CANCELLED") continue;
      const len = e.end - e.start;
      for (const start of occurrences(e, to)) {
        const o = overrides.get(`${e.uid}|${start.getTime()}`);
        const item = o ? { ...o, allDay: o.allDay } : { ...e, start, end: new Date(start.getTime() + len) };
        if (item.status === "CANCELLED") continue;
        if (item.start < to && (item.end > from || (item.end.getTime() === item.start.getTime() && item.start >= from))) out.push(item);
      }
    }
    // Moved instances whose new time lands today but whose series instance didn't.
    for (const o of overrides.values()) {
      if (o.status !== "CANCELLED" && o.start < to && o.end > from && !out.some((x) => x.uid === o.uid && x.start.getTime() === o.start.getTime())) out.push(o);
    }
    return out
      .map((e) => ({ summary: e.summary || "(no title)", start: e.start, end: e.end, allDay: e.allDay, location: e.location || "", url: e.url || "" }))
      .sort((a, b) => (b.allDay - a.allDay) || a.start - b.start);
  }

  // --- GitHub / Hacker News --------------------------------------------------------------

  // GitHub REST /notifications → display items.
  function parseGithubNotifications(list) {
    if (!Array.isArray(list)) throw new Error("unexpected GitHub response");
    return list.map((n) => {
      const repo = n.repository?.full_name || "";
      const api = n.subject?.url || "";
      const m = api.match(/\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases)\/([^/]+)$/);
      const kind = { pulls: "pull", issues: "issues", commits: "commit", releases: "releases" }[m?.[2]];
      const url = m ? `https://github.com/${m[1]}/${kind === "releases" ? "releases" : kind}/${m[3]}` : `https://github.com/${repo}`;
      return { title: n.subject?.title || "", repo, type: n.subject?.type || "", reason: n.reason || "", date: new Date(n.updated_at), url };
    });
  }

  // GitHub search results (issues/PRs) → display items.
  function parseGithubSearch(data) {
    if (!data || !Array.isArray(data.items)) throw new Error("unexpected GitHub response");
    return data.items.map((i) => ({
      title: i.title || "",
      repo: (i.repository_url || "").replace("https://api.github.com/repos/", ""),
      number: i.number,
      url: i.html_url || "",
      draft: !!i.draft,
      date: new Date(i.updated_at),
    }));
  }

  function parseHnItem(item) {
    return {
      title: item?.title || "",
      url: item?.url || `https://news.ycombinator.com/item?id=${item?.id}`,
      comments: `https://news.ycombinator.com/item?id=${item?.id}`,
      score: item?.score || 0,
      count: item?.descendants || 0,
    };
  }

  // --- Formatting -----------------------------------------------------------------------

  function relTime(date, now = new Date(), locale = undefined) {
    const s = Math.round((date - now) / 1000);
    const abs = Math.abs(s);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
    if (abs < 60) return rtf.format(0, "minute");
    if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
    return rtf.format(Math.round(s / 86400), "day");
  }

  const clock = (date, locale) => new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);

  // "Now", "in 25 min", or nothing, for calendar rows.
  function eventStatus(e, now = new Date()) {
    if (e.allDay) return "";
    if (e.start <= now && e.end > now) return "now";
    const mins = Math.round((e.start - now) / 60000);
    if (mins > 0 && mins <= 60) return `in ${mins} min`;
    return "";
  }

  // --- Cache ------------------------------------------------------------------------------

  class Cache {
    constructor(ttlMs, now = () => Date.now()) {
      this.ttl = ttlMs;
      this.now = now;
      this.map = new Map();
    }
    get(key) {
      const e = this.map.get(key);
      return e && this.now() - e.at < this.ttl ? e.value : undefined;
    }
    set(key, value) {
      this.map.set(key, { value, at: this.now() });
    }
  }

  return {
    cardFor, decode, parseGmailAtom, parseICS, occurrences, eventsOnDay, zoned, tzOffset,
    parseGithubNotifications, parseGithubSearch, parseHnItem, relTime, clock, eventStatus, Cache,
  };
})();
