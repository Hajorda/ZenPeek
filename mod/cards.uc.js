// @ts-check
// Zen Peek — the card registry. Each card says, in one place, which sites it's
// for, how it loads its data, what its unread count is (for the badge on the
// Essential) and how it's drawn. Drawing goes through `ui` helpers that peek.uc.js
// provides, so cards never touch the DOM or Zen directly.
//
// Adding a card: parsing in core.uc.js, fetching in sources.uc.js, then
// register({ type, match, enabled, load, render, ... }) here and a
// "card-<type>" checkbox in preferences.json.
/* exported ZPCards */
// eslint-disable-next-line no-var
var ZPCards = (() => {
  "use strict";
  const Core = ZPCore;
  const Sources = ZPSources;

  /**
   * @typedef {{ type: string, account?: number }} Card
   * @typedef {object} CardDef
   * @property {string} type
   * @property {(url: URL) => Card | null} match       Which card (if any) a site gets.
   * @property {(s: any) => boolean} enabled           Turned on in the settings?
   * @property {(card: Card, s: any) => string} [key]  Cache key; include every setting that changes the data.
   * @property {(ctx: any) => Promise<any>} load        Fetches the data.
   * @property {(data: any, s: any) => number | null} [count]  Unread count for the badge.
   * @property {boolean} [titleCounts]                 The open page's title shows the same count (and is live).
   * @property {{ secret: string, button: string, menu: string }} [setup]  A secret the card needs.
   * @property {(data: any, ui: any) => any[]} render
   */

  /** @type {Map<string, CardDef>} */
  const defs = new Map();

  /** @param {CardDef} def */
  function register(def) {
    for (const k of ["type", "match", "enabled", "load", "render"]) {
      if (!def?.[k]) throw new Error(`Zen Peek card is missing "${k}"`);
    }
    defs.set(def.type, def);
  }

  // The card for a URL, or null.
  function match(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    for (const def of defs.values()) {
      const card = def.match(u);
      if (card) return card;
    }
    return null;
  }

  const keyOf = (card, s) => defs.get(card.type)?.key?.(card, s) ?? `${card.type}:${s.items}`;
  const host = (u) => u.hostname.replace(/^www\./, "");

  // --- Gmail -------------------------------------------------------------------
  register({
    type: "gmail",
    match(u) {
      if (host(u) !== "mail.google.com") return null;
      const m = u.pathname.match(/\/mail\/u\/(\d+)/);
      return { type: "gmail", account: m ? Number(m[1]) : 0 };
    },
    enabled: (s) => s.cards.gmail,
    key: (card, s) => `gmail:${card.account ?? 0}:${s.items}`,
    load: ({ card, s, fetchFn, signal, timeoutMs }) => Sources.gmail({ fetchFn, account: card.account, limit: s.items, signal, timeoutMs }),
    count: (d) => d.unread,
    titleCounts: true, // "Inbox (3) - …" while the tab is open
    render(d, ui) {
      const { t, s } = ui;
      return [
        ui.header(t("gmail.title"), d.unread ? t("unread", { n: d.unread }) : ""),
        ...(d.mails.length
          ? d.mails.map((m) => ui.row({
            primary: m.from || t("gmail.unknown-sender"),
            meta: ui.relTime(m.date),
            secondary: m.subject || t("gmail.no-subject"),
            extra: s.gmailSnippets ? m.snippet : "",
            url: m.url,
          }))
          : [ui.empty(t("gmail.empty"))]),
      ];
    },
  });

  // --- Google Calendar (any iCal address) ----------------------------------------
  register({
    type: "calendar",
    match: (u) => (host(u) === "calendar.google.com" ? { type: "calendar" } : null),
    enabled: (s) => s.cards.calendar,
    setup: { secret: "calendar", button: "button.set-calendar", menu: "menu.set-calendar" },
    async load({ s, fetchFn, signal, timeoutMs, secret }) {
      const icsUrls = (await secret("calendar")).split(" ").filter(Boolean);
      if (signal.aborted) throw new Sources.SourceError("aborted", "Cancelled");
      return Sources.calendar({ fetchFn, icsUrls, limit: Math.max(s.items, 8), signal, timeoutMs });
    },
    render(d, ui) {
      const { t, s, now } = ui;
      const events = s.calendarPast ? d.events : d.events.filter((e) => e.allDay || e.end > now);
      const rows = events.slice(0, s.items).map((e) => {
        const status = Core.eventStatus(e, now);
        const statusText = status ? (status.kind === "now" ? t("cal.now") : t("cal.soon", { n: status.minutes })) : "";
        return ui.row({
          primary: e.summary || t("cal.no-title"),
          meta: statusText || (e.allDay ? t("cal.all-day") : `${ui.clock(e.start)} – ${ui.clock(e.end)}`),
          accent: !!status,
          secondary: e.location && !(e.meeting && e.location.includes(e.meeting.url)) ? e.location : "",
          dim: !e.allDay && e.end <= now,
          action: Core.joinable(e, now, s.calendarJoin)
            ? { text: t("cal.join"), label: t("cal.join-label", { provider: e.meeting.provider }), url: e.meeting.url, newTab: true }
            : null,
        });
      });
      const today = new Intl.DateTimeFormat(ui.locale, { weekday: "long", day: "numeric", month: "long" }).format(now);
      const out = [ui.header(today), ...(rows.length ? rows : [ui.empty(t("cal.empty"))])];
      if (d.next && s.calendarNext) {
        const when = new Intl.DateTimeFormat(ui.locale, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(d.next.start);
        out.push(ui.subhead(t("cal.next")), ui.row({ primary: d.next.summary || t("cal.no-title"), meta: when }));
      }
      return out;
    },
  });

  // --- GitHub ----------------------------------------------------------------------
  const CI_MARK = { passing: "✓", failing: "✗", running: "●" };
  register({
    type: "github",
    match: (u) => (host(u) === "github.com" ? { type: "github" } : null),
    enabled: (s) => s.cards.github,
    key: (card, s) => `github:${s.items}:${[s.githubReviews, s.githubMine, s.githubNotifications, s.githubCi].map(Number).join("")}`,
    setup: { secret: "github", button: "button.set-github", menu: "menu.set-github" },
    async load({ s, fetchFn, signal, timeoutMs, secret }) {
      const token = await secret("github");
      if (signal.aborted) throw new Sources.SourceError("aborted", "Cancelled");
      return Sources.github({
        fetchFn, token, limit: s.items, signal, timeoutMs,
        sections: { reviews: s.githubReviews, mine: s.githubMine, notifications: s.githubNotifications, ci: s.githubCi },
      });
    },
    count: (d, s) => (s.githubNotifications ? d.count : 0) + (s.githubReviews ? d.reviews.length : 0),
    render(d, ui) {
      const { t, s } = ui;
      const pr = (p, meta, accent, label) => ui.row({ primary: p.title, secondary: `${p.repo} #${p.number}`, meta, accent, url: p.url, label });
      const out = [ui.header(t("gh.title"), s.githubNotifications && d.count ? t("unread", { n: d.count }) : "")];
      if (s.githubReviews && d.reviews.length) {
        out.push(ui.subhead(t("gh.reviews", { n: d.reviews.length })));
        out.push(...d.reviews.map((p) => pr(p, ui.relTime(p.date), true)));
      }
      if (s.githubMine && d.mine.length) {
        out.push(ui.subhead(t("gh.mine")));
        out.push(...d.mine.map((p) => {
          const status = t(`gh.status.${p.status}`);
          const ci = s.githubCi && p.ci ? p.ci : "";
          const meta = ci ? `${status} · ${CI_MARK[ci] || ""}` : status;
          const label = [p.title, `${p.repo} #${p.number}`, status, ci ? t(`gh.ci.${ci}`) : ""].filter(Boolean).join(", ");
          return pr(p, meta, p.status === "approved" || p.status === "changes requested" || ci === "failing", label);
        }));
      }
      if (s.githubNotifications) {
        out.push(ui.subhead(t("gh.notifications")));
        out.push(...(d.items.length
          ? d.items.map((n) => ui.row({ primary: n.title, secondary: `${n.repo} · ${n.reason.replace(/_/g, " ")}`, meta: ui.relTime(n.date), url: n.url }))
          : [ui.empty(t("gh.empty"))]));
      }
      if (out.length === 1) out.push(ui.empty(t("gh.all-off")));
      return out;
    },
  });

  // --- Hacker News -------------------------------------------------------------------
  const hnItems = new Map(); // story id -> { item, at }; kept small by Sources.hn
  register({
    type: "hn",
    match: (u) => (host(u) === "news.ycombinator.com" ? { type: "hn" } : null),
    enabled: (s) => s.cards.hn,
    load: ({ s, fetchFn, signal, timeoutMs }) => Sources.hn({ fetchFn, limit: s.items, signal, timeoutMs, itemCache: hnItems }),
    render(d, ui) {
      const { t } = ui;
      return [
        ui.header(t("hn.title")),
        ...d.items.map((it) => ui.row({ primary: it.title, meta: `▲ ${it.score}`, secondary: t("hn.comments", { n: it.count }), url: it.url })),
      ];
    },
  });

  return {
    register,
    match,
    keyOf,
    get: (type) => defs.get(type),
    types: () => [...defs.keys()],
  };
})();
