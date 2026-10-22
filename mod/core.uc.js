// @ts-check
// Zen Peek — pure logic: feed/calendar parsing, recurring events, time zones,
// unread counts in tab titles, meeting links, caching, formatting.
// No browser internals here (DOMParser is used when the engine has it).
/* exported ZPCore */
// eslint-disable-next-line no-var
var ZPCore = (() => {
  "use strict";

  /**
   * @typedef {{ subject: string, snippet: string, from: string, date: Date, url: string }} Mail
   * @typedef {{ unread: number, mails: Mail[] }} GmailData
   * @typedef {{ url: string, provider: string }} Meeting
   * @typedef {{ summary: string, start: Date, end: Date, allDay: boolean, location: string, url: string, meeting: Meeting | null, calendar: string, calIndex: number }} CalendarEvent
   * @typedef {{ title: string, repo: string, number?: number, url: string, draft?: boolean, date: Date, status?: string, ci?: string }} GithubItem
   * @typedef {{ count: number | null, dot: boolean, more?: boolean }} TitleBadge
   * @typedef {object} RawEvent  An iCalendar VEVENT while it's being read.
   * @property {any[]} exdates
   * @property {string} [summary] @property {string} [location] @property {string} [uid] @property {string} [status]
   * @property {string} [url] @property {string} [description] @property {string} [conference]
   * @property {Record<string, string>} [rrule] @property {string} [duration]
   * @property {any} [_start] @property {any} [_end] @property {any} [_rid]
   * @property {Date} [start] @property {Date} [end] @property {boolean} [allDay] @property {Date} [recurrenceId] @property {Date} [until]
   * @property {string} [calendar] @property {number} [calIndex]
   */

  /** Hostname without "www.", or "" for something that isn't a URL. */
  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
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
  // Uses a real XML parser when the engine has one (always, inside Zen);
  // the regular-expression reader is the fallback for tests and odd engines.
  /** @returns {GmailData} */
  function parseGmailAtom(xml) {
    return typeof DOMParser === "function" ? parseGmailAtomDom(xml, DOMParser) : parseGmailAtomText(xml);
  }

  /** @returns {GmailData} */
  function parseGmailAtomDom(xml, Parser) {
    const doc = new Parser().parseFromString(String(xml), "application/xml");
    const root = doc.documentElement;
    if (!root || root.localName !== "feed" || doc.getElementsByTagName("parsererror").length) {
      throw new Error("not a Gmail feed (signed out?)");
    }
    const child = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
    const text = (el, name) => (child(el, name)?.textContent || "").trim();
    const mails = [...root.children].filter((c) => c.localName === "entry").map((e) => {
      const author = child(e, "author");
      return {
        subject: text(e, "title"),
        snippet: text(e, "summary"),
        from: text(author, "name") || text(author, "email"),
        date: new Date(text(e, "issued") || text(e, "modified")),
        url: child(e, "link")?.getAttribute("href") || "",
      };
    });
    return { unread: Number(text(root, "fullcount")) || 0, mails };
  }

  /** @returns {GmailData} */
  function parseGmailAtomText(xml) {
    xml = String(xml);
    if (!/<feed[\s>]/i.test(xml)) throw new Error("not a Gmail feed (signed out?)");
    const fullcount = Number(tag(xml, "fullcount")) || 0;
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => {
      const e = m[1];
      const author = (e.match(/<author>([\s\S]*?)<\/author>/i) || [])[1] || "";
      const link = (e.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
      return {
        subject: tag(e, "title"),
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
    let calName = "";
    /** @type {RawEvent[]} */
    const events = [];
    /** @type {RawEvent | null} */
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
        if (name === "X-WR-CALNAME") calName = value.replace(/\\([,;\\])/g, "$1").trim();
        continue;
      }
      const text = () => value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
      switch (name.toUpperCase()) {
        case "SUMMARY": ev.summary = text(); break;
        case "LOCATION": ev.location = text(); break;
        case "UID": ev.uid = value; break;
        case "STATUS": ev.status = value; break;
        case "URL": ev.url = value; break;
        case "DESCRIPTION": ev.description = text(); break;
        case "CONFERENCE": case "X-GOOGLE-CONFERENCE": ev.conference = value; break;
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
      e.calendar = calName;
    }
    return events.filter((e) => e.start instanceof Date && !isNaN(e.start.getTime()));
  }

  function durationMs(d) {
    const m = d.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!m) return 0;
    const [, w, dd, h, mi, s] = m.map((x) => Number(x) || 0);
    return ((((w * 7 + dd) * 24 + h) * 60 + mi) * 60 + s) * 1000;
  }

  const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const nums = (v) => String(v || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0);
  // "MO" → every Monday; "2TU" → 2nd Tuesday; "-1FR" → last Friday.
  const parseByday = (v) => String(v || "").split(",").map((x) => {
    const m = x.trim().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
    return m ? { ord: m[1] ? Number(m[1]) : 0, wd: DAYS.indexOf(m[2]) } : null;
  }).filter((x) => x !== null);

  // Days (1–31) of month `m` in year `y` that a MONTHLY/YEARLY rule picks, in order.
  // Handles BYDAY (with ordinals), BYMONTHDAY (negative = from the end) and BYSETPOS.
  function ruleDaysInMonth(y, m, r, startDay) {
    const last = new Date(y, m + 1, 0).getDate();
    const fromEnd = (n) => (n > 0 ? n : last + 1 + n);
    const byday = parseByday(r.BYDAY);
    let days;
    if (byday.length) {
      const picked = new Set();
      for (const { ord, wd } of byday) {
        const all = [];
        for (let d = 1; d <= last; d++) if (new Date(y, m, d).getDay() === wd) all.push(d);
        if (!ord) all.forEach((d) => picked.add(d));
        else {
          const d = ord > 0 ? all[ord - 1] : all[all.length + ord];
          if (d) picked.add(d);
        }
      }
      days = [...picked];
      if (r.BYMONTHDAY) {
        const md = new Set(nums(r.BYMONTHDAY).map(fromEnd));
        days = days.filter((d) => md.has(d));
      }
    } else if (r.BYMONTHDAY) {
      days = nums(r.BYMONTHDAY).map(fromEnd);
    } else {
      days = [startDay];
    }
    days = [...new Set(days)].filter((d) => d >= 1 && d <= last).sort((a, b) => a - b);
    if (r.BYSETPOS) {
      days = [...new Set(nums(r.BYSETPOS).map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter(Boolean))].sort((a, b) => a - b);
    }
    return days;
  }

  // Start times of an event's occurrences that begin before `until` (Date).
  // Supports DAILY (BYDAY filter) / WEEKLY (BYDAY) / MONTHLY and YEARLY
  // (BYDAY with ordinals like "2nd Tuesday", BYMONTHDAY, BYMONTH, BYSETPOS),
  // with INTERVAL, COUNT, UNTIL and EXDATE — what calendars export in practice.
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
    const weekdays = parseByday(r.BYDAY).map((x) => x.wd);
    const months = nums(r.BYMONTH).filter((x) => x >= 1 && x <= 12).map((x) => x - 1).sort((a, b) => a - b);
    for (let i = 0; i < 20000; i++) {
      if (r.FREQ === "DAILY") {
        const d = at(s.getFullYear(), s.getMonth(), s.getDate() + i * interval);
        if (d >= stop) break;
        if (weekdays.length && !weekdays.includes(d.getDay())) continue; // e.g. weekdays only
        if (!push(d)) break;
      } else if (r.FREQ === "WEEKLY") {
        const byday = weekdays.length ? weekdays : [s.getDay()];
        const weekStart = at(s.getFullYear(), s.getMonth(), s.getDate() - s.getDay() + i * 7 * interval);
        if (weekStart >= stop) break;
        let go = true;
        for (const wd of [...new Set(byday)].sort((a, b) => a - b)) {
          go = push(at(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + wd));
          if (!go) break;
        }
        if (!go) break;
      } else if (r.FREQ === "MONTHLY") {
        const first = new Date(s.getFullYear(), s.getMonth() + i * interval, 1);
        if (first >= stop) break;
        if (months.length && !months.includes(first.getMonth())) continue;
        let go = true;
        for (const d of ruleDaysInMonth(first.getFullYear(), first.getMonth(), r, s.getDate())) {
          go = push(at(first.getFullYear(), first.getMonth(), d));
          if (!go) break;
        }
        if (!go) break;
      } else if (r.FREQ === "YEARLY") {
        const y = s.getFullYear() + i * interval;
        if (new Date(y, 0, 1) >= stop) break;
        let go = true;
        for (const mo of months.length ? months : [s.getMonth()]) {
          for (const d of ruleDaysInMonth(y, mo, r, s.getDate())) {
            go = push(at(y, mo, d));
            if (!go) break;
          }
          if (!go) break;
        }
        if (!go) break;
      } else {
        push(s);
        break;
      }
      if (n >= count) break;
    }
    return out;
  }

  // Video-call links found in an event (Google Meet, Zoom, Teams, Webex, Jitsi, Whereby).
  const MEETING = [
    [/https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3}\b/i, "Google Meet"],
    [/https:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w|s)\/[^\s"'<>]+/i, "Zoom"],
    [/https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>]+/i, "Teams"],
    [/https:\/\/[\w-]+\.webex\.com\/[^\s"'<>]+/i, "Webex"],
    [/https:\/\/meet\.jit\.si\/[^\s"'<>]+/i, "Jitsi"],
    [/https:\/\/whereby\.com\/[^\s"'<>]+/i, "Whereby"],
  ];
  /** @returns {Meeting | null} */
  function meetingLink(ev) {
    for (const text of [ev.conference, ev.location, ev.url, ev.description]) {
      if (!text) continue;
      for (const [re, provider] of MEETING) {
        const m = String(text).match(re);
        if (m) return { url: m[0].replace(/[).,;>\]]+$/, ""), provider: String(provider) };
      }
    }
    return null;
  }

  // Events overlapping the local day that contains `day`, sorted, with
  // single-instance changes (RECURRENCE-ID) replacing their series instance.
  /** @returns {CalendarEvent[]} */
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
      .map((e) => ({
        summary: e.summary || "", start: e.start, end: e.end, allDay: !!e.allDay,
        location: e.location || "", url: e.url || "", meeting: meetingLink(e),
        calendar: e.calendar || "", calIndex: e.calIndex || 0,
      }))
      .sort((a, b) => (Number(b.allDay) - Number(a.allDay)) || a.start - b.start);
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
      return { id: String(n.id ?? ""), title: n.subject?.title || "", repo, type: n.subject?.type || "", reason: n.reason || "", date: new Date(n.updated_at), url };
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

  // GitHub GraphQL search results (pull requests) → display items, with the
  // review decision and the CI state of the latest commit.
  const CI = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "running", EXPECTED: "running" };
  /** @returns {{ reviews: GithubItem[], mine: GithubItem[] }} */
  function parseGithubGraphql(json) {
    if (!json || typeof json !== "object") throw new Error("unexpected GitHub response");
    if (Array.isArray(json.errors) && json.errors.length && !json.data) throw new Error(json.errors[0]?.message || "GitHub GraphQL error");
    const list = (conn) => (Array.isArray(conn?.nodes) ? conn.nodes : []).filter((n) => n && n.url);
    const item = (p) => ({
      title: p.title || "",
      repo: p.repository?.nameWithOwner || "",
      number: p.number,
      url: p.url,
      draft: !!p.isDraft,
      date: new Date(p.updatedAt),
    });
    const status = (p) => (p.isDraft ? "draft" : p.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : p.reviewDecision === "APPROVED" ? "approved" : "waiting for review");
    return {
      reviews: list(json.data?.reviews).map(item),
      mine: list(json.data?.mine).map((p) => ({
        ...item(p),
        status: status(p),
        ci: CI[p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state] || "",
      })),
    };
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

  // --- Unread counts in tab titles -------------------------------------------------------
  // "(3) WhatsApp", "[12] Discord", "(99+) Slack", "Inbox (3) - me@gmail.com - Gmail",
  // and a dot for "• Discord" / "* Slack" (unread, no number). Years like "(2024)" are ignored.
  /** @returns {TitleBadge | null} */
  function parseTitleBadge(title) {
    const t = String(title || "").trim();
    const m = t.match(/^[([](\d{1,4})(\+?)[)\]]/) || t.match(/^[\p{L}\p{M} ]{1,30}\((\d{1,4})(\+?)\)(?=\s+[-–—|·•])/u);
    if (m) {
      const n = Number(m[1]);
      if (!m[2] && n >= 1900 && n <= 2099) return null;
      return n > 0 ? { count: n, dot: false, more: !!m[2] } : null;
    }
    if (/^[•●*]\s*\S/.test(t)) return { count: null, dot: true };
    return null;
  }

  // Text for a badge: "3", "99+", "" (a dot), or null (no badge).
  function badgeText(count, { dot = false, style = "count" } = {}) {
    if (style === "off") return null;
    if (count > 0) return style === "dot" ? "" : count > 99 ? "99+" : String(count);
    return dot ? "" : null;
  }

  // --- Formatting -----------------------------------------------------------------------

  function relTime(date, now = new Date(), locale = undefined) {
    const s = Math.round((+date - +now) / 1000);
    const abs = Math.abs(s);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
    if (abs < 60) return rtf.format(0, "minute");
    if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
    return rtf.format(Math.round(s / 86400), "day");
  }

  const clock = (date, locale = undefined) => new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);

  // Where a calendar event is relative to now: { kind: "now" }, { kind: "soon", minutes } (within the hour), or null.
  function eventStatus(e, now = new Date()) {
    if (e.allDay) return null;
    if (e.start <= now && e.end > now) return { kind: "now", minutes: 0 };
    const minutes = Math.round((+e.start - +now) / 60000);
    if (minutes > 0 && minutes <= 60) return { kind: "soon", minutes };
    return null;
  }

  // Should the "Join" button show? `mode`: "soon" (10 min before until the end), "always", "off".
  function joinable(e, now = new Date(), mode = "soon") {
    if (!e.meeting || mode === "off" || e.allDay) return false;
    if (e.end <= now) return false;
    return mode === "always" || +e.start - +now <= 10 * 60_000;
  }

  // The hours a day timeline should show: 8:00–20:00, widened to fit the
  // day's timed events and the current time, on whole hours.
  function timelineRange(events, day = new Date(), now = new Date()) {
    const at = (h) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime();
    const dayStart = at(0), dayEnd = at(24);
    let from = at(8), to = at(20);
    const times = events.filter((e) => !e.allDay).flatMap((e) => [+e.start, +e.end]);
    if (+now >= dayStart && +now < dayEnd) times.push(+now);
    for (const t of times) {
      from = Math.max(dayStart, Math.min(from, t));
      to = Math.min(dayEnd, Math.max(to, t));
    }
    const hour = 3600_000;
    return { from: dayStart + Math.floor((from - dayStart) / hour) * hour, to: dayStart + Math.ceil((to - dayStart) / hour) * hour };
  }

  // --- Weather (Open-Meteo) -----------------------------------------------------------

  // WMO weather codes → a condition key (texts live in strings.uc.js) and an icon.
  function weatherKind(code, isDay = true) {
    const c = Number(code);
    if (c === 0) return { key: "clear", icon: isDay ? "☀️" : "🌙" };
    if (c <= 2) return { key: "partly", icon: isDay ? "⛅" : "☁️" };
    if (c === 3) return { key: "cloudy", icon: "☁️" };
    if (c === 45 || c === 48) return { key: "fog", icon: "🌫️" };
    if (c >= 51 && c <= 57) return { key: "drizzle", icon: "🌦️" };
    if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { key: "rain", icon: "🌧️" };
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { key: "snow", icon: "🌨️" };
    if (c >= 95) return { key: "thunder", icon: "⛈️" };
    return { key: "cloudy", icon: "☁️" };
  }

  // Open-Meteo forecast → now, today's high/low and the next `hours` hours.
  // Its times are local to the place ("2026-10-22T14:00"), with utc_offset_seconds.
  function parseWeather(json, { now = new Date(), hours = 6 } = {}) {
    if (!json?.current || !json?.hourly?.time) throw new Error("unexpected weather response");
    const offset = Number(json.utc_offset_seconds) || 0;
    const local = (t) => new Date(Date.parse(`${t}Z`) - offset * 1000);
    const current = json.current;
    const isDay = current.is_day !== 0;
    const next = [];
    const h = json.hourly;
    for (let i = 0; i < h.time.length && next.length < hours; i++) {
      const time = local(h.time[i]);
      if (+time + 3600_000 <= +now) continue;
      next.push({ time, temp: Math.round(h.temperature_2m[i]), code: h.weather_code[i], pop: h.precipitation_probability?.[i] ?? null });
    }
    return {
      current: {
        temp: Math.round(current.temperature_2m),
        feels: Math.round(current.apparent_temperature),
        code: current.weather_code,
        wind: Math.round(current.wind_speed_10m),
        isDay,
      },
      today: { max: Math.round(json.daily?.temperature_2m_max?.[0]), min: Math.round(json.daily?.temperature_2m_min?.[0]) },
      hours: next,
    };
  }

  // --- Pointer intent ---------------------------------------------------------------------

  const area = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  // Is point p inside triangle abc (edges included)?
  function inTriangle(p, a, b, c) {
    const d1 = area(p, a, b), d2 = area(p, b, c), d3 = area(p, c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  }
  // Is the pointer (now at `p`, having left at `origin`) on its way to `rect` (the preview)?
  // The "safe triangle" runs from just behind the origin to the preview's near edge.
  function headingToward(origin, p, rect, slack = 12) {
    if (p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom) return true;
    const nearX = Math.abs(rect.left - origin.x) <= Math.abs(rect.right - origin.x) ? rect.left : rect.right;
    const dir = Math.sign(nearX - origin.x) || 1;
    const back = { x: origin.x - dir * slack, y: origin.y };
    return inTriangle(p, back, { x: nearX, y: rect.top - slack }, { x: nearX, y: rect.bottom + slack });
  }

  // --- Cache ------------------------------------------------------------------------------

  // A small LRU cache: entries expire after `ttl` (but peek() still returns them,
  // marked not fresh), and only the `max` most recently used are kept.
  class Cache {
    constructor(ttlMs, now = () => Date.now(), max = 50) {
      this.ttl = ttlMs;
      this.now = now;
      this.max = max;
      /** @type {Map<string, { value: any, at: number }>} */
      this.map = new Map();
    }
    _touch(key, e) {
      this.map.delete(key);
      this.map.set(key, e);
    }
    get(key) {
      const e = this.map.get(key);
      if (!e || this.now() - e.at >= this.ttl) return undefined;
      this._touch(key, e);
      return e.value;
    }
    // Like get(), but also returns expired entries, marked as not fresh, so a
    // caller can show them instantly while it fetches new data.
    peek(key) {
      const e = this.map.get(key);
      if (!e) return undefined;
      const age = this.now() - e.at;
      return { value: e.value, age, at: e.at, fresh: age < this.ttl };
    }
    set(key, value) {
      this.setAt(key, value, this.now());
    }
    // Stores a value fetched at time `at` (e.g. by another window); older data never replaces newer.
    setAt(key, value, at) {
      const old = this.map.get(key);
      if (old && old.at > at) return false;
      this._touch(key, { value, at });
      while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
      return true;
    }
    // Drops entries older than `maxAgeMs`.
    prune(maxAgeMs) {
      const now = this.now();
      for (const [k, e] of this.map) if (now - e.at > maxAgeMs) this.map.delete(k);
    }
    clear() {
      this.map.clear();
    }
  }

  // JSON can't hold Dates; these tag them as { $date: ms } and back.
  const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
  function toStorable(v) {
    if (isDate(v)) return { $date: v.getTime() };
    if (Array.isArray(v)) return v.map(toStorable);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toStorable(x)]));
    return v;
  }
  function fromStorable(v) {
    if (Array.isArray(v)) return v.map(fromStorable);
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === "$date") return new Date(typeof v.$date === "number" ? v.$date : NaN);
      return Object.fromEntries(keys.map((k) => [k, fromStorable(v[k])]));
    }
    return v;
  }

  return {
    hostOf, decode, parseGmailAtom, parseGmailAtomDom, parseGmailAtomText, parseICS, occurrences, eventsOnDay, meetingLink,
    zoned, tzOffset, parseGithubNotifications, parseGithubSearch, parseGithubGraphql, parseHnItem,
    parseTitleBadge, badgeText, relTime, clock, eventStatus, joinable, inTriangle, headingToward,
    timelineRange, weatherKind, parseWeather,
    Cache, toStorable, fromStorable,
  };
})();
