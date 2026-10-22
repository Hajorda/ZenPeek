// Zen Peek — hover an Essential to see a preview: latest mail, today's
// calendar, GitHub notifications, Hacker News, or a snapshot of the page.
// Needs core.uc.js (ZPCore), sources.uc.js (ZPSources), zen-adapter.uc.js (ZPZen).
(() => {
  "use strict";
  const Core = ZPCore;
  const Sources = ZPSources;
  const Zen = ZPZen;
  if (!Zen.supported) return;

  const P = "zen.peek.";
  const LOGIN_ORIGIN = "chrome://zen-peek";
  const WIDTHS = { narrow: 280, normal: 320, wide: 380 };

  const bool = (name, d) => {
    try {
      return Services.prefs.getBoolPref(P + name, d);
    } catch {
      return Services.prefs.getStringPref(P + name, String(d)) === "true";
    }
  };
  const num = (name, d) => {
    try {
      return Services.prefs.getIntPref(P + name, d);
    } catch {
      const v = Number(Services.prefs.getStringPref(P + name, ""));
      return Number.isFinite(v) && v > 0 ? v : d;
    }
  };
  const str = (name, d) => {
    try {
      return Services.prefs.getStringPref(P + name, d) || d;
    } catch {
      return d;
    }
  };
  // Every setting has its default here (Sine doesn't apply preference defaults).
  const readSettings = () => ({
    // General
    style: str("style", "card") === "popup" ? "popup" : "card",
    delay: Math.min(3000, Math.max(150, num("delay", 500))),
    width: WIDTHS[str("width", "normal")] || WIDTHS.normal,
    items: Math.min(10, Math.max(1, num("items", 5))),
    refreshMs: Math.min(3600, Math.max(15, num("refresh", 90))) * 1000,
    motion: ["normal", "fast", "off"].includes(str("motion", "normal")) ? str("motion", "normal") : "normal",
    newTab: str("open-links", "same") === "new",
    // Which cards are on
    cards: {
      gmail: bool("card-gmail", true),
      calendar: bool("card-calendar", true),
      github: bool("card-github", true),
      hn: bool("card-hn", true),
    },
    // Card options
    gmailSnippets: bool("gmail-snippets", false),
    calendarPast: bool("calendar-past", true),
    calendarNext: bool("calendar-next", true),
    githubReviews: bool("github-reviews", true),
    githubMine: bool("github-mine", true),
    githubNotifications: bool("github-notifications", true),
    // Other sites
    pinned: bool("pinned-tabs", false),
    snapshots: bool("snapshots", true),
    // Troubleshooting
    debug: bool("debug", false),
  });

  // Settings are read once and cached; a preference observer drops the cache
  // whenever any zen.peek.* preference changes. If the observer can't be
  // registered, settings are simply re-read every time (slower, still correct).
  const cleanups = [];
  let settingsCache = null;
  let settingsObserved = false;
  const settings = () => (settingsObserved && settingsCache) || (settingsCache = readSettings());
  {
    const observer = { observe: () => (settingsCache = null) };
    try {
      Services.prefs.addObserver(P, observer);
      settingsObserved = true;
      cleanups.push(() => Services.prefs.removeObserver(P, observer));
    } catch { /* fall back to reading every time */ }
  }

  // --- Diagnostics -------------------------------------------------------------
  // The last 60 events are always kept (cheap); with the "debug" setting on they
  // are also logged. ZenPeek.diagnostics() returns them with the last placement.
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const events = [];
  function note(event, data = {}) {
    events.push({ t: Math.round(clock()), event, ...data });
    if (events.length > 60) events.shift();
    if (settings().debug) console.log("[Zen Peek] debug:", event, data);
  }
  function diagnostics() {
    const { debug, style, delay, width, items, refreshMs, motion } = settings();
    return JSON.parse(JSON.stringify({
      settings: { debug, style, delay, width, items, refreshMs, motion },
      panel: { style: Zen.panelStyle ?? null, open: Zen.panelOpen() },
      lastPlacement: Zen.lastPlacement ?? null,
      window: { w: window.innerWidth, h: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      events,
    }));
  }

  // --- Secrets (calendar address, GitHub token) in the password manager ------

  const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");
  async function getSecret(name) {
    const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: name });
    return logins[0]?.password || "";
  }
  async function setSecret(name, value) {
    const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: name });
    for (const l of logins) Services.logins.removeLogin(l);
    if (value) await Services.logins.addLoginAsync(new LoginInfo(LOGIN_ORIGIN, null, name, name, value, "", ""));
    // Drop data and requests made with the old value.
    cancelLoads();
    cache.map.clear();
  }

  async function askCalendar() {
    const input = { value: "" };
    const ok = Services.prompt.prompt(
      window, "Zen Peek",
      "Paste your Google Calendar's secret address in iCal format.\n\nGoogle Calendar → Settings → your calendar → Integrate calendar → " +
      "\"Secret address in iCal format\". For several calendars, separate addresses with spaces.\n\nIt's stored in Zen's password manager.",
      input, null, {},
    );
    if (!ok) return;
    const urls = input.value.split(/\s+/).filter((u) => /^https:\/\//.test(u));
    await setSecret("calendar", urls.join(" "));
  }

  async function askGithub() {
    const input = { value: "" };
    const ok = Services.prompt.promptPassword(
      window, "Zen Peek",
      "Paste a GitHub personal access token with the \"notifications\" scope (github.com → Settings → Developer settings → Tokens (classic)).\n\nIt's stored in Zen's password manager.",
      input,
    );
    if (ok) await setSecret("github", input.value.trim());
  }

  // --- Loading card data ---------------------------------------------------

  // Cached data older than this isn't shown while a refresh runs.
  const MAX_STALE_MS = 30 * 60_000;
  const cache = new Core.Cache(90_000);
  const inflight = new Map(); // key -> { promise, controller }
  const keyOf = (card, s) => `${card.type}:${card.account ?? ""}:${s.items}`;
  const abortedError = () => new Sources.SourceError("aborted", "Cancelled");

  // Fresh data for a card. Concurrent calls share one request; the request can
  // be cancelled with cancelLoads(), which rejects with code "aborted".
  function load(card, s = settings()) {
    cache.ttl = s.refreshMs;
    const key = keyOf(card, s);
    const hit = cache.get(key);
    if (hit) return Promise.resolve(hit);
    const running = inflight.get(key);
    if (running) return running.promise;
    const controller = new AbortController();
    const { signal } = controller;
    const started = clock();
    const limit = s.items;
    const promise = (async () => {
      const fetchFn = (url, init) => fetch(url, init);
      let data;
      if (card.type === "gmail") data = await Sources.gmail({ fetchFn, account: card.account, limit, signal });
      else if (card.type === "calendar") {
        const icsUrls = (await getSecret("calendar")).split(" ").filter(Boolean);
        if (signal.aborted) throw abortedError();
        data = await Sources.calendar({ fetchFn, icsUrls, limit: Math.max(limit, 8), signal });
      } else if (card.type === "github") {
        const token = await getSecret("github");
        if (signal.aborted) throw abortedError();
        data = await Sources.github({ fetchFn, token, limit, signal });
      } else if (card.type === "hn") data = await Sources.hn({ fetchFn, limit, signal });
      if (signal.aborted) throw abortedError();
      cache.set(key, data);
      note("fetched", { card: card.type, ms: Math.round(clock() - started) });
      return data;
    })()
      .catch((e) => {
        // Whatever failed after a cancel (e.g. reading the body) counts as cancelled.
        throw signal.aborted ? abortedError() : e;
      })
      .finally(() => {
        if (inflight.get(key)?.controller === controller) inflight.delete(key);
      });
    inflight.set(key, { promise, controller });
    return promise;
  }

  // Cancel requests nobody is waiting for any more (except `keepKey`).
  function cancelLoads(keepKey = null) {
    for (const [key, r] of inflight) {
      if (key === keepKey) continue;
      r.controller.abort();
      inflight.delete(key);
      note("cancelled", { key });
    }
  }

  const hostOf = (tab) => {
    try {
      return new URL(Zen.tabUrl(tab)).host;
    } catch {
      return "";
    }
  };

  // The card to show for a tab, or null (no card for this site, or turned off).
  function cardForTab(tab, s) {
    const card = Core.cardFor(Zen.tabUrl(tab));
    return card && s.cards[card.type] ? card : null;
  }

  // --- Rendering (text only; nothing from a site is ever parsed as HTML) -------

  const h = (...a) => Zen.html(...a);

  function header(tab, title, badge) {
    const icon = Zen.tabIcon(tab);
    return h("div", { class: "zp-header" }, [
      icon ? h("img", { class: "zp-icon", src: icon, alt: "" }) : null,
      h("span", { class: "zp-title", text: title }),
      badge ? h("span", { class: "zp-badge", text: badge }) : null,
    ]);
  }

  function row({ primary, secondary, extra, meta, url, dim, accent }, tab) {
    return h("div", {
      class: `zp-row${dim ? " zp-dim" : ""}${url ? " zp-link" : ""}`,
      onclick: url ? (e) => {
        Zen.closePanel();
        Zen.openLink(url, tab, { newTab: settings().newTab || !!(e.button === 1 || e.ctrlKey || e.metaKey) });
      } : null,
    }, [
      h("div", { class: "zp-row-main" }, [
        h("span", { class: "zp-primary", text: primary }),
        meta ? h("span", { class: `zp-meta${accent ? " zp-accent" : ""}`, text: meta }) : null,
      ]),
      secondary ? h("div", { class: "zp-secondary", text: secondary }) : null,
      extra ? h("div", { class: "zp-extra", text: extra }) : null,
    ]);
  }

  const empty = (text) => h("div", { class: "zp-empty", text });

  function renderGmail(tab, d, s) {
    return [
      header(tab, "Gmail", d.unread ? `${d.unread} unread` : ""),
      ...(d.mails.length
        ? d.mails.map((m) => row({ primary: m.from || "(unknown)", meta: Core.relTime(m.date), secondary: m.subject, extra: s.gmailSnippets ? m.snippet : "", url: m.url }, tab))
        : [empty("Inbox zero 🎉")]),
    ];
  }

  function renderCalendar(tab, d, s) {
    const now = new Date();
    const events = s.calendarPast ? d.events : d.events.filter((e) => e.allDay || e.end > now);
    const rows = events.slice(0, s.items).map((e) => {
      const status = Core.eventStatus(e, now);
      return row({
        primary: e.summary,
        meta: status || (e.allDay ? "All day" : `${Core.clock(e.start)} – ${Core.clock(e.end)}`),
        accent: !!status,
        secondary: e.location,
        dim: !e.allDay && e.end <= now,
      }, tab);
    });
    const today = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(now);
    const out = [header(tab, today), ...(rows.length ? rows : [empty("Nothing today")])];
    if (d.next && s.calendarNext) {
      const when = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(d.next.start);
      out.push(h("div", { class: "zp-subhead", text: "Next" }), row({ primary: d.next.summary, meta: when }, tab));
    }
    return out;
  }

  function renderGithub(tab, d, s) {
    const pr = (p, meta, accent) => row({ primary: p.title, secondary: `${p.repo} #${p.number}`, meta, accent, url: p.url }, tab);
    const out = [header(tab, "GitHub", s.githubNotifications && d.count ? `${d.count} unread` : "")];
    if (s.githubReviews && d.reviews.length) {
      out.push(h("div", { class: "zp-subhead", text: `Review requested · ${d.reviews.length}` }));
      out.push(...d.reviews.map((p) => pr(p, Core.relTime(p.date), true)));
    }
    if (s.githubMine && d.mine.length) {
      out.push(h("div", { class: "zp-subhead", text: "Your pull requests" }));
      out.push(...d.mine.map((p) => pr(p, p.status, p.status === "approved" || p.status === "changes requested")));
    }
    if (s.githubNotifications) {
      out.push(h("div", { class: "zp-subhead", text: "Notifications" }));
      out.push(...(d.items.length
        ? d.items.map((n) => row({ primary: n.title, secondary: `${n.repo} · ${n.reason.replace(/_/g, " ")}`, meta: Core.relTime(n.date), url: n.url }, tab))
        : [empty("No unread notifications")]));
    }
    if (out.length === 1) out.push(empty("All GitHub sections are turned off in Zen Peek's settings"));
    return out;
  }

  function renderHn(tab, d, s) {
    return [header(tab, "Hacker News · Top"), ...d.items.map((s) => row({ primary: s.title, meta: `▲ ${s.score}`, secondary: `${s.count} comments`, url: s.url }, tab))];
  }

  const RENDER = { gmail: renderGmail, calendar: renderCalendar, github: renderGithub, hn: renderHn };

  const ERRORS = {
    setup: null, // uses the error's own message
    "signed-out": "Sign in to this account in Zen to see it here.",
    auth: "Access was refused. Check the address or token.",
    network: "Couldn't connect. Are you offline?",
    server: "The service returned an error. Try again soon.",
    parse: null,
  };

  function renderError(tab, card, err) {
    const out = [header(tab, Zen.tabTitle(tab)), empty(ERRORS[err.code] || err.message || "Couldn't load this preview.")];
    const fix = card.type === "calendar" ? ["Set calendar address…", askCalendar] : card.type === "github" ? ["Set GitHub token…", askGithub] : null;
    if (fix && (err.code === "setup" || err.code === "auth" || err.code === "parse")) {
      out.push(h("button", { class: "zp-button", text: fix[0], onclick: () => {
        Zen.closePanel();
        fix[1]();
      } }));
    }
    return out;
  }

  async function renderPage(tab, s) {
    const out = [header(tab, Zen.tabTitle(tab))];
    if (s.snapshots && Zen.isLoaded(tab)) {
      const canvas = await Zen.snapshot(tab, s.width - 16);
      if (canvas) {
        canvas.className = "zp-snapshot";
        out.push(canvas);
      }
    }
    let host = "";
    try {
      host = new URL(Zen.tabUrl(tab)).host;
    } catch { /* no host */ }
    if (host) out.push(h("div", { class: "zp-host", text: host + (Zen.isLoaded(tab) ? "" : " · not loaded") }));
    return out;
  }

  // --- Hover logic ---------------------------------------------------------------

  let showTimer = null;
  let hideTimer = null;
  let prefetchTimer = null;
  let shownFor = null;
  let token = 0;

  function fill(nodes) {
    const root = Zen.panelRoot();
    if (root) root.replaceChildren(...nodes);
    Zen.reposition?.();
  }

  // Picks up setting changes (style, width, animation) on the next hover, no restart.
  const ensurePanel = (s = settings()) => {
    Zen.panel({ onEnter: cancelHide, onLeave: scheduleHide, onLost: () => hide("essential-hidden"), style: s.style });
    Zen.configure?.({ width: s.width, motion: s.motion });
  };

  // Open the panel at `tab`. False if it couldn't (the Essential isn't visible).
  function openAt(tab, s) {
    const ok = Zen.openPanel(tab) !== false;
    note(ok ? "open" : "open-refused", { style: s.style, placement: Zen.lastPlacement ?? null });
    if (!ok) shownFor = null;
    return ok;
  }

  async function show(tab) {
    const my = ++token;
    const s = settings();
    const current = () => my === token && shownFor === tab;
    ensurePanel(s);
    shownFor = tab;
    const card = cardForTab(tab, s);

    if (!card) {
      cancelLoads();
      fill([header(tab, Zen.tabTitle(tab)), h("div", { class: "zp-loading" })]);
      if (!openAt(tab, s)) return;
      const nodes = await renderPage(tab, s);
      if (current()) fill(nodes);
      return;
    }

    // Show cached data at once (even if a little old) and refresh it behind the scenes.
    const key = keyOf(card, s);
    cancelLoads(key);
    cache.ttl = s.refreshMs;
    const cached = cache.peek(key);
    const usable = cached && (cached.fresh || cached.age < MAX_STALE_MS) ? cached : null;
    fill(usable ? RENDER[card.type](tab, usable.value, s) : [header(tab, Zen.tabTitle(tab)), h("div", { class: "zp-loading" })]);
    if (!openAt(tab, s)) return;
    note("show", { card: card.type, data: usable ? (usable.fresh ? "fresh" : "stale") : "loading" });
    if (usable?.fresh) return;
    try {
      const data = await load(card, s);
      if (current()) fill(RENDER[card.type](tab, data, s));
    } catch (e) {
      if (e?.code === "aborted") return;
      console.warn("[Zen Peek]", card.type, e);
      note("error", { card: card.type, code: e?.code || "unknown" });
      // If old data is on screen, keep it rather than replacing it with an error.
      if (current() && !usable) fill(renderError(tab, card, e));
    }
  }

  // Start fetching a card's data before its panel opens.
  function prefetch(tab, s) {
    const card = cardForTab(tab, s);
    if (!card) return;
    const key = keyOf(card, s);
    cache.ttl = s.refreshMs;
    if (cache.get(key)) return;
    cancelLoads(key);
    note("prefetch", { card: card.type });
    load(card, s).catch(() => { /* shown (or ignored) when the panel opens */ });
  }

  function hide(reason = "left") {
    token++;
    shownFor = null;
    clearTimeout(prefetchTimer);
    Zen.closePanel();
    cancelLoads();
    note("hide", { reason });
  }

  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hide("left"), 400); // time to move the mouse from the icon to the card
  };
  const cancelHide = () => clearTimeout(hideTimer);

  // An older copy may still be running if Sine updated the mod without a restart.
  try {
    window.ZenPeek?.dispose?.();
  } catch (e) {
    console.warn("[Zen Peek] could not stop the previous copy", e);
  }

  function dispose() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    clearTimeout(prefetchTimer);
    cancelLoads();
    token++;
    for (const f of cleanups.splice(0)) {
      try {
        f();
      } catch { /* already gone */ }
    }
    Zen.removePanel?.();
  }

  // For the Browser Console and tests.
  window.ZenPeek = { show, hide, askCalendar, askGithub, load, cache, dispose, diagnostics };

  Zen.whenReady().then(() => {
    ensurePanel();
    const stop = Zen.watchHover({
      includePinned: () => settings().pinned,
      enter(tab) {
        cancelHide();
        clearTimeout(showTimer);
        clearTimeout(prefetchTimer);
        const s = settings();
        // Moving between Essentials while a preview is open switches instantly.
        const delay = Zen.panelOpen() ? 60 : s.delay;
        // Only the hostname is logged: titles can contain e-mail addresses.
        note("enter", { host: hostOf(tab), delay });
        // Start fetching once the pointer rests (not while it only passes over
        // icons), so the data is usually ready by the time the panel opens.
        prefetchTimer = setTimeout(() => prefetch(tab, s), Math.min(80, delay));
        showTimer = setTimeout(() => show(tab), delay);
      },
      leave() {
        clearTimeout(showTimer);
        clearTimeout(prefetchTimer);
        scheduleHide();
      },
    });
    Zen.addTabMenuItems([
      { label: "Zen Peek: set calendar address…", command: askCalendar, show: (t) => Core.cardFor(Zen.tabUrl(t))?.type === "calendar" },
      { label: "Zen Peek: set GitHub token…", command: askGithub, show: (t) => Core.cardFor(Zen.tabUrl(t))?.type === "github" },
    ]);
    const onKey = (e) => e.key === "Escape" && Zen.panelOpen() && hide("escape");
    window.addEventListener("keydown", onKey, true);
    cleanups.push(stop, () => window.removeEventListener("keydown", onKey, true));
    window.addEventListener("unload", dispose, { once: true });
    console.log("[Zen Peek] ready");
  }).catch((e) => console.error("Zen Peek failed to start", e));
})();
