// @ts-check
// Zen Peek — the card registry. Each card says, in one place, which sites it's
// for, how it loads its data, what its unread count is (for the badge on the
// Essential) and how it's drawn. Drawing goes through `ui` helpers that peek.uc.js
// provides, so cards never touch the DOM or Zen directly.
//
// Adding a built-in card: parsing in core.uc.js, fetching in sources.uc.js,
// then register({ type, match, load, render, ... }) here and a "card-<type>"
// checkbox in preferences.json. Other mods use ZenPeek.registerCard (README).
/* exported ZPCards */
// eslint-disable-next-line no-var
var ZPCards = (() => {
  "use strict";
  const Core = ZPCore;
  const Sources = ZPSources;

  /**
   * @typedef {{ type: string, account?: number }} Card
   * @typedef {object} Setup  Something a card needs before it can load.
   * @property {"secret" | "pref"} kind  Where it's kept: the password manager, or a zen.peek.* preference.
   * @property {string} name             Secret name, or preference name without "zen.peek.".
   * @property {"text" | "password"} input
   * @property {string} button           Text key of the error card's button.
   * @property {string} menu             Text key of the tab right-click menu item.
   * @property {string} form             Text keys "setup.<form>.title/help/placeholder/link/invalid".
   * @property {string} [link]           Where to get it (opened by the form's link).
   * @property {(value: string) => string | null} validate  Cleaned value, or null if invalid.
   *
   * @typedef {object} CardDef
   * @property {string} type
   * @property {string} [name]                         Shown in "Show as"; defaults to the "card.<type>" text.
   * @property {(url: URL) => Card | null} match       Which card (if any) a site gets.
   * @property {(s: any) => boolean} [enabled]         Turned on in the settings? Default: the "card-<type>" checkbox.
   * @property {(card: Card, s: any) => string} [key]  Cache key; include every setting that changes the data.
   * @property {(ctx: any) => Promise<any>} load        Fetches the data.
   * @property {(data: any, s: any) => number | null} [count]  Unread count for the badge.
   * @property {boolean} [titleCounts]                 The open page's title shows the same count (and is live).
   * @property {Setup} [setup]
   * @property {(data: any, ui: any) => any[]} render
   * @property {(card: Card) => { url: string, label: string }} [create]  A "+" button: write a mail, add an event…
   * @property {boolean} [external]                    Added by another mod.
   */

  /** @type {Map<string, CardDef>} */
  const defs = new Map();

  /** @param {CardDef} def */
  function register(def) {
    for (const k of ["type", "match", "load", "render"]) {
      if (!def?.[k]) throw new Error(`Zen Peek card is missing "${k}"`);
    }
    const type = def.type;
    defs.set(type, { enabled: (s) => s.cards?.[type] !== false, ...def });
  }

  // Calls a card's own function, so one broken card (another mod's, say) can't break the others.
  const guarded = (fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      console.warn("[Zen Peek] a card failed:", e);
      return fallback;
    }
  };
  const parse = (url) => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  };

  // The card for a URL, or null.
  function match(url) {
    const u = parse(url);
    if (!u) return null;
    for (const def of defs.values()) {
      const card = guarded(() => def.match(u), null);
      if (card?.type === def.type) return card;
    }
    return null;
  }

  // Like match(), but with the user's choice for this Essential ("Show as"):
  // "page" → no card; a card type → that card, even on another site.
  function cardFor(url, choice = "") {
    if (choice === "page") return null;
    const def = choice && defs.get(choice);
    if (def) {
      const u = parse(url);
      const own = u && guarded(() => def.match(u), null);
      return own?.type === def.type ? own : { type: def.type };
    }
    return match(url);
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
    key: (card, s) => `gmail:${card.account ?? 0}:${s.gmailCount}`,
    load: ({ card, s, fetchFn, signal, timeoutMs }) =>
      Sources.gmail({ fetchFn, account: card.account ?? 0, limit: s.gmailCount, signal, timeoutMs }),
    count: (d) => d.unread,
    titleCounts: true, // "Inbox (3) - …" while the tab is open
    create: (card) => ({ url: `https://mail.google.com/mail/u/${card.account ?? 0}/#inbox?compose=new`, label: "create.gmail" }),
    render(d, ui) {
      const { t, s } = ui;
      const rows = d.mails.map((m) => ui.row({
        primary: m.from || t("gmail.unknown-sender"),
        meta: ui.relTime(m.date),
        secondary: m.subject || t("gmail.no-subject"),
        extra: s.gmailSnippets ? m.snippet : "",
        url: m.url,
      }));
      // One list; the card scrolls when there are more than fit.
      return [ui.header(t("gmail.title"), d.unread ? t("unread", { n: d.unread }) : ""), ...(rows.length ? rows : [ui.empty(t("gmail.empty"))])];
    },
  });

  // --- Google Calendar (any iCal address) ----------------------------------------
  const CAL_COLOURS = ["#4f86f7", "#e5484d", "#30a46c", "#f5a524", "#8e4ec6", "#12a594", "#e54666", "#6e56cf"];
  const calColour = (e) => CAL_COLOURS[(e.calIndex || 0) % CAL_COLOURS.length];

  // Today as a bar: each timed event a coloured block, the current time a red line.
  function timeline(events, ui) {
    const { from, to } = Core.timelineRange(events, ui.now, ui.now);
    const span = to - from;
    const pct = (t) => ((Math.min(Math.max(+t, from), to) - from) / span) * 100;
    const hour = new Intl.DateTimeFormat(ui.locale, { hour: "numeric" });
    const blocks = events.filter((e) => !e.allDay && +e.end > from && +e.start < to).map((e) => ui.el("div", {
      class: `zp-tl-event${+e.end <= +ui.now ? " zp-tl-past" : ""}`,
      style: `left:${pct(e.start).toFixed(2)}%;width:${Math.max(1, pct(e.end) - pct(e.start)).toFixed(2)}%;--zp-cal:${calColour(e)}`,
      title: e.summary || ui.t("cal.no-title"),
    }));
    const now = +ui.now >= from && +ui.now <= to ? ui.el("div", { class: "zp-tl-now", style: `left:${pct(ui.now).toFixed(2)}%` }) : null;
    const mid = from + Math.round(span / 2 / 3600_000) * 3600_000;
    return ui.el("div", { class: "zp-timeline", role: "img", "aria-label": ui.t("cal.timeline", { from: ui.clock(new Date(from)), to: ui.clock(new Date(to)) }) }, [
      ui.el("div", { class: "zp-tl-track" }, [...blocks, now]),
      ui.el("div", { class: "zp-tl-labels", "aria-hidden": "true" }, [from, mid, to].map((x) => ui.el("span", { text: hour.format(x) }))),
    ]);
  }

  register({
    type: "calendar",
    match: (u) => (host(u) === "calendar.google.com" ? { type: "calendar" } : null),
    create: () => ({ url: "https://calendar.google.com/calendar/r/eventedit", label: "create.calendar" }),
    setup: {
      kind: "secret", name: "calendar", input: "text", form: "calendar",
      button: "button.set-calendar", menu: "menu.set-calendar",
      link: "https://calendar.google.com/calendar/r/settings",
      validate: (v) => {
        const urls = String(v).split(/\s+/).filter((u) => /^https:\/\/\S+$/.test(u));
        return urls.length ? urls.join(" ") : null;
      },
    },
    async load({ s, fetchFn, signal, timeoutMs, secret }) {
      const icsUrls = (await secret("calendar")).split(" ").filter(Boolean);
      if (signal.aborted) throw new Sources.SourceError("aborted", "Cancelled");
      return Sources.calendar({ fetchFn, icsUrls, limit: Math.max(s.items * 2, 10), signal, timeoutMs });
    },
    render(d, ui) {
      const { t, s, now } = ui;
      const several = (d.calendars?.length || 0) > 1;
      const events = s.calendarPast ? d.events : d.events.filter((e) => e.allDay || e.end > now);
      const rows = events.map((e) => {
        const status = Core.eventStatus(e, now);
        const statusText = status ? (status.kind === "now" ? t("cal.now") : t("cal.soon", { n: status.minutes })) : "";
        const where = e.location && !(e.meeting && e.location.includes(e.meeting.url)) ? e.location : "";
        return ui.row({
          primary: e.summary || t("cal.no-title"),
          meta: statusText || (e.allDay ? t("cal.all-day") : `${ui.clock(e.start)} – ${ui.clock(e.end)}`),
          accent: !!status,
          secondary: where || (several ? e.calendar : ""),
          dim: !e.allDay && e.end <= now,
          colour: several && s.calendarColours ? calColour(e) : "",
          action: Core.joinable(e, now, s.calendarJoin)
            ? { text: t("cal.join"), label: t("cal.join-label", { provider: e.meeting.provider }), url: e.meeting.url, newTab: true }
            : null,
        });
      });
      const today = new Intl.DateTimeFormat(ui.locale, { weekday: "long", day: "numeric", month: "long" }).format(now);
      const out = [ui.header(today)];
      if (s.calendarTimeline && d.events.some((e) => !e.allDay)) out.push(timeline(d.events, ui));
      out.push(...(rows.length ? [...rows.slice(0, s.items), ...ui.more(rows.slice(s.items))] : [ui.empty(t("cal.empty"))]));
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
    key: (card, s) => `github:${s.items}:${[s.githubReviews, s.githubMine, s.githubNotifications, s.githubCi].map(Number).join("")}`,
    setup: {
      kind: "secret", name: "github", input: "password", form: "github",
      button: "button.set-github", menu: "menu.set-github",
      link: "https://github.com/settings/tokens/new?scopes=notifications&description=Zen%20Peek",
      validate: (v) => (/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(String(v).trim()) ? String(v).trim() : null),
    },
    async load({ s, fetchFn, signal, timeoutMs, secret }) {
      const token = await secret("github");
      if (signal.aborted) throw new Sources.SourceError("aborted", "Cancelled");
      return Sources.github({
        fetchFn, token, limit: s.items * 2, signal, timeoutMs,
        sections: { reviews: s.githubReviews, mine: s.githubMine, notifications: s.githubNotifications, ci: s.githubCi },
      });
    },
    count: (d, s) => (s.githubNotifications ? d.count : 0) + (s.githubReviews ? d.reviews.length : 0),
    render(d, ui) {
      const { t, s } = ui;
      const firstAndMore = (rows) => [...rows.slice(0, s.items), ...ui.more(rows.slice(s.items))];
      const pr = (p, meta, accent, label) => ui.row({ primary: p.title, secondary: `${p.repo} #${p.number}`, meta, accent, url: p.url, label });
      const out = [ui.header(t("gh.title"), s.githubNotifications && d.count ? t("unread", { n: d.count }) : "")];
      if (s.githubReviews && d.reviews.length) {
        out.push(ui.subhead(t("gh.reviews", { n: d.reviews.length })));
        out.push(...firstAndMore(d.reviews.map((p) => pr(p, ui.relTime(p.date), true))));
      }
      if (s.githubMine && d.mine.length) {
        out.push(ui.subhead(t("gh.mine")));
        out.push(...firstAndMore(d.mine.map((p) => {
          const status = t(`gh.status.${p.status}`);
          const ci = s.githubCi && p.ci ? p.ci : "";
          const meta = ci ? `${status} · ${CI_MARK[ci] || ""}` : status;
          const label = [p.title, `${p.repo} #${p.number}`, status, ci ? t(`gh.ci.${ci}`) : ""].filter(Boolean).join(", ");
          return pr(p, meta, p.status === "approved" || p.status === "changes requested" || ci === "failing", label);
        })));
      }
      if (s.githubNotifications) {
        out.push(ui.subhead(t("gh.notifications")));
        // "✓" marks one as read on GitHub, and it leaves the card (and the badge) at once.
        const markRead = (n) => async () => {
          await Sources.githubMarkRead({ fetchFn: ui.fetch, token: await ui.secret("github"), id: n.id });
          ui.update({ ...d, items: d.items.filter((x) => x.id !== n.id), count: Math.max(0, d.count - 1) });
        };
        out.push(...(d.items.length
          ? firstAndMore(d.items.map((n) => ui.row({
            primary: n.title, secondary: `${n.repo} · ${n.reason.replace(/_/g, " ")}`, meta: ui.relTime(n.date), url: n.url,
            action: n.id && s.githubMarkRead ? { text: "✓", label: t("gh.mark-read"), run: markRead(n), quiet: true } : null,
          })))
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
    load: ({ s, fetchFn, signal, timeoutMs }) => Sources.hn({ fetchFn, limit: s.items * 2, signal, timeoutMs, itemCache: hnItems }),
    render(d, ui) {
      const { t, s } = ui;
      const rows = d.items.map((it) => ui.row({ primary: it.title, meta: `▲ ${it.score}`, secondary: t("hn.comments", { n: it.count }), url: it.url }));
      return [ui.header(t("hn.title")), ...rows.slice(0, s.items), ...ui.more(rows.slice(s.items))];
    },
  });

  // --- Weather (Open-Meteo, for a place you choose) --------------------------------------
  const WEATHER_SITES = /(^|\.)(weather\.com|accuweather\.com|wunderground\.com|yr\.no|windy\.com|weather\.gov|meteoblue\.com|openweathermap\.org|mgm\.gov\.tr|metoffice\.gov\.uk|meteo\.(fr|ch|de))$/;
  const geoCache = new Map(); // place name -> coordinates
  register({
    type: "weather",
    match: (u) => (WEATHER_SITES.test(host(u)) || (host(u) === "timeanddate.com" && u.pathname.startsWith("/weather")) ? { type: "weather" } : null),
    key: (card, s) => `weather:${s.weatherLocation.toLowerCase()}:${s.weatherUnits}`,
    setup: {
      kind: "pref", name: "weather-location", input: "text", form: "weather",
      button: "button.set-location", menu: "menu.set-location",
      validate: (v) => (String(v).trim().length > 0 && String(v).trim().length <= 80 ? String(v).trim() : null),
    },
    load: ({ s, fetchFn, signal, timeoutMs }) => Sources.weather({ fetchFn, place: s.weatherLocation, units: s.weatherUnits, signal, timeoutMs, geoCache }),
    render(d, ui) {
      const { t } = ui;
      const kind = Core.weatherKind(d.current.code, d.current.isDay);
      const hour = new Intl.DateTimeFormat(ui.locale, { hour: "numeric" });
      const unit = d.units === "imperial" ? "mph" : "km/h";
      return [
        ui.header(t("wx.title", { place: d.place })),
        ui.el("div", { class: "zp-wx-now" }, [
          ui.el("span", { class: "zp-wx-icon", text: kind.icon, "aria-hidden": "true" }),
          ui.el("span", { class: "zp-wx-temp", text: `${d.current.temp}°` }),
          ui.el("div", { class: "zp-wx-desc" }, [
            ui.el("div", { class: "zp-primary", text: t(`wx.${kind.key === "rain" ? "rain-kind" : kind.key}`) }),
            ui.el("div", { class: "zp-secondary", text: `${t("wx.feels", { t: d.current.feels })} · ${t("wx.high-low", d.today)}` }),
            ui.el("div", { class: "zp-secondary", text: t("wx.wind", { n: d.current.wind, unit }) }),
          ]),
        ]),
        ui.el("div", { class: "zp-wx-hours" }, d.hours.map((h) => {
          const k = Core.weatherKind(h.code, true);
          return ui.el("div", { class: "zp-wx-hour", title: t(`wx.${k.key === "rain" ? "rain-kind" : k.key}`) }, [
            ui.el("span", { class: "zp-meta", text: hour.format(h.time) }),
            ui.el("span", { class: "zp-wx-hour-icon", text: k.icon, "aria-hidden": "true" }),
            ui.el("span", { class: "zp-wx-hour-temp", text: `${h.temp}°` }),
            h.pop ? ui.el("span", { class: "zp-wx-pop", text: t("wx.rain", { n: h.pop }) }) : null,
          ]);
        })),
      ];
    },
  });

  const BUILT_IN = new Set(defs.keys());

  return {
    register,
    unregister: (type) => !BUILT_IN.has(type) && defs.delete(type),
    match,
    cardFor,
    keyOf,
    guarded,
    builtIn: (type) => BUILT_IN.has(type),
    get: (type) => defs.get(type),
    types: () => [...defs.keys()],
  };
})();
