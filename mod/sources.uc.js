// Zen Peek — fetches the data behind each card. `fetchFn` is injected so the
// tests can run without a network. Errors carry a `code` the UI explains.
// eslint-disable-next-line no-var
var ZPSources = (() => {
  "use strict";
  const Core = ZPCore;

  class SourceError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code; // setup | signed-out | auth | network | server | parse
    }
  }

  async function get(fetchFn, url, init = {}) {
    let res;
    try {
      res = await fetchFn(url, { cache: "no-store", ...init });
    } catch (e) {
      throw new SourceError("network", String(e?.message || e));
    }
    if (res.status === 401 || res.status === 403) throw new SourceError("auth", `HTTP ${res.status}`);
    if (!res.ok) throw new SourceError("server", `HTTP ${res.status}`);
    return res;
  }

  // Gmail: the unread Atom feed, using the browser's own Google login.
  async function gmail({ fetchFn, account = 0, limit = 5 }) {
    const res = await get(fetchFn, `https://mail.google.com/mail/u/${account}/feed/atom`, { credentials: "include" });
    const text = await res.text();
    let data;
    try {
      data = Core.parseGmailAtom(text);
    } catch {
      throw new SourceError("signed-out", "Not signed in to Gmail in this browser");
    }
    return { unread: data.unread, mails: data.mails.slice(0, limit) };
  }

  // Google Calendar: the private iCal address (Settings → your calendar →
  // "Secret address in iCal format"). Today's events, plus the next one if today is empty.
  async function calendar({ fetchFn, icsUrls = [], now = new Date(), limit = 8 }) {
    if (!icsUrls.length) throw new SourceError("setup", "Add your calendar's secret iCal address in Zen Peek's settings");
    const all = [];
    for (const url of icsUrls) {
      const res = await get(fetchFn, url);
      try {
        all.push(...Core.parseICS(await res.text()));
      } catch {
        throw new SourceError("parse", "That address didn't return a calendar");
      }
    }
    const today = Core.eventsOnDay(all, now).slice(0, limit); // past ones are shown dimmed
    let next = null;
    if (!today.some((e) => !e.allDay && e.end > now)) {
      for (let i = 1; i <= 14 && !next; i++) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        next = Core.eventsOnDay(all, day).find((e) => !e.allDay) || null;
      }
    }
    return { events: today, next };
  }

  // GitHub: unread notifications with a personal access token (notifications scope).
  async function github({ fetchFn, token, limit = 5 }) {
    if (!token) throw new SourceError("setup", "Set a GitHub token (right-click a GitHub Essential → Zen Peek: set GitHub token…)");
    const res = await get(fetchFn, "https://api.github.com/notifications?per_page=20", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    const items = Core.parseGithubNotifications(await res.json());
    return { count: items.length, items: items.slice(0, limit) };
  }

  // Hacker News: public API, top stories.
  async function hn({ fetchFn, limit = 5 }) {
    const ids = await (await get(fetchFn, "https://hacker-news.firebaseio.com/v0/topstories.json")).json();
    const items = await Promise.all(
      ids.slice(0, limit).map(async (id) => Core.parseHnItem(await (await get(fetchFn, `https://hacker-news.firebaseio.com/v0/item/${id}.json`)).json())),
    );
    return { items };
  }

  return { SourceError, gmail, calendar, github, hn };
})();
