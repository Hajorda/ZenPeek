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
  const settings = () => ({
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
  });

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

  const cache = new Core.Cache(90_000);
  const inflight = new Map();

  async function load(card, s = settings()) {
    cache.ttl = s.refreshMs;
    const limit = s.items;
    const key = `${card.type}:${card.account ?? ""}:${limit}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const fetchFn = (url, init) => fetch(url, init);
      let data;
      if (card.type === "gmail") data = await Sources.gmail({ fetchFn, account: card.account, limit });
      else if (card.type === "calendar") data = await Sources.calendar({ fetchFn, icsUrls: (await getSecret("calendar")).split(" ").filter(Boolean), limit: Math.max(limit, 8) });
      else if (card.type === "github") data = await Sources.github({ fetchFn, token: await getSecret("github"), limit });
      else if (card.type === "hn") data = await Sources.hn({ fetchFn, limit });
      cache.set(key, data);
      return data;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
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
  let shownFor = null;
  let token = 0;

  function fill(nodes) {
    const root = Zen.panelRoot();
    if (root) root.replaceChildren(...nodes);
    Zen.reposition?.();
  }

  // Picks up setting changes (style, width, animation) on the next hover, no restart.
  const ensurePanel = (s = settings()) => {
    Zen.panel({ onEnter: cancelHide, onLeave: scheduleHide, style: s.style });
    Zen.configure?.({ width: s.width, motion: s.motion });
  };

  async function show(tab) {
    const my = ++token;
    const s = settings();
    ensurePanel(s);
    shownFor = tab;
    let card = Core.cardFor(Zen.tabUrl(tab));
    if (card && !s.cards[card.type]) card = null; // turned off: show the page instead
    fill([header(tab, Zen.tabTitle(tab)), h("div", { class: "zp-loading" })]);
    Zen.openPanel(tab);
    let nodes;
    if (card) {
      try {
        nodes = RENDER[card.type](tab, await load(card, s), s);
      } catch (e) {
        console.warn("[Zen Peek]", card.type, e);
        nodes = renderError(tab, card, e);
      }
    } else {
      nodes = await renderPage(tab, s);
    }
    if (my === token && shownFor === tab) fill(nodes);
  }

  function hide() {
    token++;
    shownFor = null;
    Zen.closePanel();
  }

  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 400); // time to move the mouse from the icon to the card
  };
  const cancelHide = () => clearTimeout(hideTimer);

  // An older copy may still be running if Sine updated the mod without a restart.
  try {
    window.ZenPeek?.dispose?.();
  } catch (e) {
    console.warn("[Zen Peek] could not stop the previous copy", e);
  }

  const cleanups = [];
  function dispose() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    token++;
    for (const f of cleanups.splice(0)) {
      try {
        f();
      } catch { /* already gone */ }
    }
    Zen.removePanel?.();
  }

  // For the Browser Console and tests.
  window.ZenPeek = { show, hide, askCalendar, askGithub, load, cache, dispose };

  Zen.whenReady().then(() => {
    ensurePanel();
    const stop = Zen.watchHover({
      includePinned: () => settings().pinned,
      enter(tab) {
        cancelHide();
        clearTimeout(showTimer);
        // Moving between Essentials while a preview is open switches instantly.
        showTimer = setTimeout(() => show(tab), Zen.panelOpen() ? 60 : settings().delay);
      },
      leave() {
        clearTimeout(showTimer);
        scheduleHide();
      },
    });
    Zen.addTabMenuItems([
      { label: "Zen Peek: set calendar address…", command: askCalendar, show: (t) => Core.cardFor(Zen.tabUrl(t))?.type === "calendar" },
      { label: "Zen Peek: set GitHub token…", command: askGithub, show: (t) => Core.cardFor(Zen.tabUrl(t))?.type === "github" },
    ]);
    const onKey = (e) => e.key === "Escape" && Zen.panelOpen() && hide();
    window.addEventListener("keydown", onKey, true);
    cleanups.push(stop, () => window.removeEventListener("keydown", onKey, true));
    window.addEventListener("unload", dispose, { once: true });
    console.log("[Zen Peek] ready");
  }).catch((e) => console.error("Zen Peek failed to start", e));
})();
