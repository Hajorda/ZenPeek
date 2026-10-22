// Zen Peek — hover an Essential to see a preview: latest mail, today's
// calendar, GitHub pull requests and notifications, Hacker News, or a snapshot
// of the page; plus unread badges on Essentials.
// Needs core, strings, sources, zen-adapter and cards (ZPCore, ZPStrings,
// ZPSources, ZPZen, ZPCards), loaded before this file.
(() => {
  "use strict";
  const Core = ZPCore;
  const Sources = ZPSources;
  const Strings = ZPStrings;
  const Cards = ZPCards;
  const Zen = ZPZen;
  if (!Zen.supported) return;

  const P = "zen.peek.";
  const LOGIN_ORIGIN = "chrome://zen-peek";
  const WIDTHS = { narrow: 280, normal: 320, wide: 380 };
  const t = (key, vars) => Strings.t(key, vars);

  // --- Settings ----------------------------------------------------------------

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
  const oneOf = (name, options, d) => (options.includes(str(name, d)) ? str(name, d) : d);
  const appLocale = () => {
    try {
      return Services.locale.appLocaleAsBCP47;
    } catch {
      return "en";
    }
  };

  // Every setting has its default here (Sine doesn't apply preference defaults).
  const readSettings = () => ({
    // General
    style: str("style", "card") === "popup" ? "popup" : "card",
    delay: Math.min(3000, Math.max(150, num("delay", 300))),
    close: oneOf("close", ["smart", "pause"], "smart"),
    width: WIDTHS[str("width", "normal")] || WIDTHS.normal,
    items: Math.min(10, Math.max(1, num("items", 5))),
    refreshMs: Math.min(3600, Math.max(15, num("refresh", 90))) * 1000,
    timeoutMs: Math.min(60, Math.max(3, num("timeout", 10))) * 1000,
    motion: oneOf("motion", ["normal", "fast", "off"], "normal"),
    newTab: str("open-links", "same") === "new",
    language: oneOf("language", ["auto", ...Strings.languages], "auto"),
    shortcut: oneOf("shortcut", ["alt-shift-p", "ctrl-alt-p", "off"], "alt-shift-p"),
    // Which cards are on
    cards: Object.fromEntries(Cards.types().map((type) => [type, bool(`card-${type}`, true)])),
    // Card options
    gmailSnippets: bool("gmail-snippets", false),
    calendarPast: bool("calendar-past", true),
    calendarNext: bool("calendar-next", true),
    calendarJoin: oneOf("calendar-join", ["soon", "always", "off"], "soon"),
    githubReviews: bool("github-reviews", true),
    githubMine: bool("github-mine", true),
    githubNotifications: bool("github-notifications", true),
    githubCi: bool("github-ci", true),
    // Badges
    badges: oneOf("badges", ["dot", "count", "off"], "dot"),
    badgesTitle: bool("badges-title", true),
    // Data
    background: bool("background", true),
    persist: bool("persist", true),
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
  const timers = new Set();
  let settingsCache = null;
  let settingsObserved = false;
  function settings() {
    if (settingsObserved && settingsCache) return settingsCache;
    settingsCache = readSettings();
    Strings.use(settingsCache.language === "auto" ? appLocale() : settingsCache.language);
    return settingsCache;
  }
  {
    let applyTimer = null;
    const observer = {
      observe: () => {
        settingsCache = null;
        clearTimeout(applyTimer);
        applyTimer = setTimeout(settingsChanged, 100);
      },
    };
    try {
      Services.prefs.addObserver(P, observer);
      settingsObserved = true;
      cleanups.push(() => {
        clearTimeout(applyTimer);
        Services.prefs.removeObserver(P, observer);
      });
    } catch { /* fall back to reading every time */ }
  }

  // Apply changes that don't wait for the next hover.
  function settingsChanged() {
    const s = settings();
    if (!s.persist) forgetSaved();
    scheduleBadges();
  }

  // --- Diagnostics -------------------------------------------------------------
  // The last 60 events are always kept (cheap); with the "debug" setting on they
  // are also logged. ZenPeek.diagnostics() returns them with the last placement.
  // Only hostnames, card types and error codes are recorded: never titles, mail or tokens.
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const events = [];
  function note(event, data = {}) {
    events.push({ t: Math.round(clock()), event, ...data });
    if (events.length > 60) events.shift();
    if (settings().debug) console.log("[Zen Peek] debug:", event, data);
  }
  function diagnostics() {
    const { debug, style, delay, close, width, items, refreshMs, timeoutMs, motion, badges, background, persist, language } = settings();
    return JSON.parse(JSON.stringify({
      settings: { debug, style, delay, close, width, items, refreshMs, timeoutMs, motion, badges, background, persist, language },
      language: Strings.locale,
      panel: { style: Zen.panelStyle ?? null, open: Zen.panelOpen() },
      lastPlacement: Zen.lastPlacement ?? null,
      window: { w: window.innerWidth, h: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      cache: { entries: cache.map.size },
      backoff: [...failures].map(([key, f]) => ({
        card: key.split(":")[0], code: f.error?.code, failures: f.count, waitS: Math.max(0, Math.round((f.until - Date.now()) / 1000)),
      })),
      events,
    }));
  }

  // --- Timers that dispose() always clears --------------------------------------

  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };

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
    // Drop data and requests made with the old value, in every window and on disk.
    clearAll();
    broadcast({ kind: "clear" });
    forgetSaved();
    later(backgroundTick, 500);
  }

  async function askCalendar() {
    const input = { value: "" };
    if (!Services.prompt.prompt(window, "Zen Peek", t("prompt.calendar"), input, null, {})) return;
    const urls = input.value.split(/\s+/).filter((u) => /^https:\/\//.test(u));
    await setSecret("calendar", urls.join(" "));
  }

  async function askGithub() {
    const input = { value: "" };
    if (Services.prompt.promptPassword(window, "Zen Peek", t("prompt.github"), input)) await setSecret("github", input.value.trim());
  }
  const ASK = { calendar: askCalendar, github: askGithub };

  // --- Loading card data ---------------------------------------------------

  // Cached data older than this is never shown (or kept on disk).
  const MAX_STALE_MS = 30 * 60_000;
  const cache = new Core.Cache(90_000, () => Date.now(), 50);
  const inflight = new Map(); // key -> { promise, controller, background }
  const failures = new Map(); // key -> { count, until, error }: background retries wait until `until`
  const abortedError = () => new Sources.SourceError("aborted", "Cancelled");

  function recordFailure(key, e) {
    const count = (failures.get(key)?.count || 0) + 1;
    const now = Date.now();
    const until = e.code === "rate-limited" ? e.retryAt || now + 60_000
      : e.code === "setup" ? now + 30 * 60_000
      : now + Math.min(30 * 60_000, 60_000 * 2 ** (count - 1)); // 1, 2, 4 … 30 min
    failures.set(key, { count, until, error: e });
    if (e.code === "rate-limited") broadcast({ kind: "blocked", key, until, retryAt: e.retryAt });
  }

  // Fresh data for a card. Concurrent calls share one request. Hover requests
  // can be cancelled with cancelLoads() (rejects with code "aborted");
  // background requests run to the end. While a service is rate-limiting us,
  // no request is made and the rate-limit error is returned.
  function load(card, s = settings(), { background = false } = {}) {
    cache.ttl = s.refreshMs;
    const key = Cards.keyOf(card, s);
    const hit = cache.get(key);
    if (hit) return Promise.resolve(hit);
    const blocked = failures.get(key);
    if (blocked?.error?.code === "rate-limited" && Date.now() < blocked.until) return Promise.reject(blocked.error);
    const running = inflight.get(key);
    if (running) return running.promise;
    const def = Cards.get(card.type);
    const controller = new AbortController();
    const { signal } = controller;
    const started = clock();
    const promise = (async () => {
      const data = await def.load({ card, s, fetchFn: (url, init) => fetch(url, init), signal, timeoutMs: s.timeoutMs, secret: getSecret });
      if (signal.aborted) throw abortedError();
      cache.set(key, data);
      failures.delete(key);
      note("fetched", { card: card.type, ms: Math.round(clock() - started), background });
      share(key);
      scheduleSave();
      scheduleBadges();
      return data;
    })()
      .catch((e) => {
        // Whatever failed after a cancel (e.g. reading the body) counts as cancelled.
        const err = signal.aborted ? abortedError() : e;
        if (err?.code !== "aborted") recordFailure(key, err);
        throw err;
      })
      .finally(() => {
        if (inflight.get(key)?.controller === controller) inflight.delete(key);
      });
    inflight.set(key, { promise, controller, background });
    return promise;
  }

  // Cancel hover requests nobody is waiting for any more (except `keepKey`).
  // Background refreshes are left alone unless `all` is set.
  function cancelLoads(keepKey = null, { all = false } = {}) {
    for (const [key, r] of inflight) {
      if (key === keepKey || (r.background && !all)) continue;
      r.controller.abort();
      inflight.delete(key);
      note("cancelled", { card: key.split(":")[0] });
    }
  }

  function clearAll() {
    cancelLoads(null, { all: true });
    cache.clear();
    failures.clear();
    scheduleBadges();
  }

  const hostOf = (tab) => Core.hostOf(Zen.tabUrl(tab));

  // The card to show for a tab, or null (no card for this site, or turned off).
  function cardForTab(tab, s) {
    const card = Cards.match(Zen.tabUrl(tab));
    return card && Cards.get(card.type).enabled(s) ? card : null;
  }

  // --- Shared between windows ---------------------------------------------------
  // Data fetched in one window is sent to the others (so each service is asked
  // once, not once per window), and the background refresh only runs in the
  // window you're using.

  const TOPIC = "zen-peek-shared";
  const windowId = Math.random().toString(36).slice(2);
  function broadcast(message) {
    try {
      Services.obs?.notifyObservers({ wrappedJSObject: { ...message, from: windowId } }, TOPIC);
    } catch (e) {
      note("share-failed", { name: e?.name });
    }
  }
  function share(key) {
    const e = cache.peek(key);
    if (e) broadcast({ kind: "data", key, value: e.value, at: e.at });
  }
  {
    const observer = {
      observe(subject) {
        const m = subject?.wrappedJSObject;
        if (!m || m.from === windowId) return;
        if (m.kind === "data") {
          let value;
          try {
            value = structuredClone(m.value); // our own copy, independent of the sending window
          } catch {
            return;
          }
          if (cache.setAt(m.key, value, m.at)) {
            failures.delete(m.key);
            scheduleBadges();
          }
        } else if (m.kind === "clear") {
          clearAll();
        } else if (m.kind === "blocked") {
          failures.set(m.key, { count: 1, until: m.until, error: new Sources.SourceError("rate-limited", "shared", { retryAt: m.retryAt }) });
        }
      },
    };
    try {
      if (Services.obs) {
        Services.obs.addObserver(observer, TOPIC);
        cleanups.push(() => Services.obs.removeObserver(observer, TOPIC));
      }
    } catch { /* this window just won't share */ }
  }

  // --- Kept between restarts (optional) -----------------------------------------
  // A small JSON file in the profile with the last data of each card, so the
  // first hover after starting Zen is instant. Never holds tokens or addresses.

  const canStore = () => typeof IOUtils !== "undefined" && typeof PathUtils !== "undefined";
  const storePath = () => PathUtils.join(PathUtils.profileDir, "zen-peek-cache.json");
  let saveTimer = null;
  function scheduleSave() {
    if (!settings().persist || !canStore()) return;
    clearTimeout(saveTimer);
    saveTimer = later(save, 3000);
  }
  async function save() {
    if (!settings().persist) return;
    cache.prune(MAX_STALE_MS);
    const entries = [...cache.map].map(([key, e]) => [key, { at: e.at, value: Core.toStorable(e.value) }]);
    try {
      await IOUtils.writeJSON(storePath(), { v: 1, entries }, { tmpPath: `${storePath()}.tmp` });
    } catch (e) {
      note("save-failed", { name: e?.name });
    }
  }
  async function restore() {
    if (!settings().persist || !canStore()) return;
    try {
      const saved = await IOUtils.readJSON(storePath());
      if (saved?.v !== 1 || !Array.isArray(saved.entries)) return;
      let n = 0;
      for (const [key, e] of saved.entries) {
        if (typeof key === "string" && Date.now() - e?.at < MAX_STALE_MS && cache.setAt(key, Core.fromStorable(e.value), e.at)) n++;
      }
      note("restored", { entries: n });
      scheduleBadges();
    } catch (e) {
      if (e?.name !== "NotFoundError") note("restore-failed", { name: e?.name });
    }
  }
  async function forgetSaved() {
    if (!canStore()) return;
    clearTimeout(saveTimer);
    try {
      await IOUtils.remove(storePath(), { ignoreAbsent: true });
    } catch { /* nothing to remove */ }
  }

  // --- Rendering (text only; nothing from a site is ever parsed as HTML) -------

  const h = (...a) => Zen.html(...a);

  // The helpers every card draws with (see cards.uc.js).
  function makeUi(tab, s) {
    const locale = Strings.locale;
    const open = (url, e, newTab = false) => {
      hide("clicked");
      Zen.openLink(url, tab, { newTab: newTab || s.newTab || !!(e && (e.button === 1 || e.ctrlKey || e.metaKey)) });
    };
    return {
      s, t, locale, now: new Date(),
      relTime: (d) => Core.relTime(d, new Date(), locale),
      clock: (d) => Core.clock(d, locale),
      header(title, badge = "") {
        Zen.setPanelLabel?.(t("a11y.preview", { name: title }));
        const icon = Zen.tabIcon(tab);
        return h("div", { class: "zp-header" }, [
          icon ? h("img", { class: "zp-icon", src: icon, alt: "" }) : null,
          h("span", { class: "zp-title", text: title }),
          badge ? h("span", { class: "zp-badge", text: badge }) : null,
        ]);
      },
      row({ primary, secondary = "", extra = "", meta = "", url = "", dim = false, accent = false, label = "", action = null }) {
        const props = { class: `zp-row${dim ? " zp-dim" : ""}${url ? " zp-link" : ""}` };
        if (url) {
          const activate = (e) => open(url, e);
          Object.assign(props, {
            role: "link",
            tabindex: "0",
            onclick: activate,
            onauxclick: (e) => e.button === 1 && activate(e),
            onkeydown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activate(e);
              }
            },
          });
        }
        if (label) props["aria-label"] = label;
        const actionEl = action
          ? h("button", {
            class: "zp-action", text: action.text, title: action.label, "aria-label": action.label,
            onclick: (e) => {
              e.stopPropagation();
              open(action.url, e, action.newTab);
            },
          })
          : null;
        return h("div", props, [
          h("div", { class: "zp-row-main" }, [
            h("span", { class: "zp-primary", text: primary }),
            meta ? h("span", { class: `zp-meta${accent ? " zp-accent" : ""}`, text: meta }) : null,
            actionEl,
          ]),
          secondary ? h("div", { class: "zp-secondary", text: secondary }) : null,
          extra ? h("div", { class: "zp-extra", text: extra }) : null,
        ]);
      },
      empty: (text) => h("div", { class: "zp-empty", text }),
      subhead: (text) => h("div", { class: "zp-subhead", role: "heading", "aria-level": "2", text }),
      button: (text, onclick) => h("button", { class: "zp-button", text, onclick }),
    };
  }

  const KNOWN_ERRORS = new Set(["signed-out", "auth", "network", "timeout", "server"]);

  function renderError(tab, card, err, s) {
    const ui = makeUi(tab, s);
    const def = Cards.get(card.type);
    let message;
    if (err.code === "setup" && def.setup) message = t(`error.setup.${def.setup.secret}`);
    else if (err.code === "rate-limited") message = t("error.rate-limited", { time: ui.clock(new Date(err.retryAt || Date.now() + 60_000)) });
    else if (err.code === "parse" && card.type === "calendar") message = t("error.parse");
    else message = KNOWN_ERRORS.has(err.code) ? t(`error.${err.code}`) : t("error.unknown");
    const out = [ui.header(Zen.tabTitle(tab)), ui.empty(message)];
    if (def.setup && ["setup", "auth", "parse"].includes(err.code)) {
      out.push(ui.button(t(def.setup.button), () => {
        hide("setup");
        ASK[def.setup.secret]?.();
      }));
    } else if (["network", "timeout", "server"].includes(err.code)) {
      out.push(ui.button(t("button.retry"), () => {
        failures.delete(Cards.keyOf(card, s));
        show(tab, { keyboard: !!keyboard });
      }));
    }
    return out;
  }

  // Snapshots of open tabs are reused for a few seconds (taking one is the
  // slowest part of a page preview); a change in the tab drops it.
  const SNAPSHOT_TTL_MS = 15_000;
  const snapshots = new WeakMap(); // tab -> { canvas, width, url, at }
  async function snapshotOf(tab, width) {
    const url = Zen.tabUrl(tab);
    const hit = snapshots.get(tab);
    if (hit && hit.width === width && hit.url === url && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.canvas;
    const canvas = await Zen.snapshot(tab, width);
    if (canvas) snapshots.set(tab, { canvas, width, url, at: Date.now() });
    return canvas;
  }

  async function renderPage(tab, s) {
    const ui = makeUi(tab, s);
    const out = [ui.header(Zen.tabTitle(tab))];
    if (s.snapshots && Zen.isLoaded(tab)) {
      const canvas = await snapshotOf(tab, s.width - 16);
      if (canvas) {
        canvas.className = "zp-snapshot";
        canvas.setAttribute?.("role", "img");
        canvas.setAttribute?.("aria-label", Zen.tabTitle(tab));
        out.push(canvas);
      }
    }
    const host = hostOf(tab);
    if (host) out.push(h("div", { class: "zp-host", text: Zen.isLoaded(tab) ? host : t("page.not-loaded", { host }) }));
    return out;
  }

  // --- Hover logic ---------------------------------------------------------------

  let showTimer = null;
  let hideTimer = null;
  let prefetchTimer = null;
  let shownFor = null;
  let token = 0;
  let keyboard = null; // { restore: element } while the preview was opened from the keyboard
  let point = null; // last pointer position
  let movedAt = 0; // when the pointer last moved
  let leftAt = null; // where the pointer was when it left the Essential
  let leftTime = 0;

  function fill(nodes) {
    const root = Zen.panelRoot();
    if (root) root.replaceChildren(...nodes);
    Zen.reposition?.();
  }

  // Picks up setting changes (style, width, animation) on the next hover, no restart.
  const ensurePanel = (s = settings()) => {
    Zen.panel({
      onEnter: onPanelEnter,
      onLeave: onPanelLeave,
      onLost: () => hide("essential-hidden"),
      // Checked a moment later: re-drawing the preview moves focus back in at once.
      onFocusOut: () => later(() => keyboard && Zen.panelOpen() && !Zen.panelHasFocus() && hide("focus-left"), 0),
      style: s.style,
    });
    Zen.configure?.({ width: s.width, motion: s.motion });
  };

  // Open the panel at `tab`. False if it couldn't (the Essential isn't visible).
  function openAt(tab, s) {
    const ok = Zen.openPanel(tab) !== false;
    note(ok ? "open" : "open-refused", { style: s.style, placement: Zen.lastPlacement ?? null });
    if (!ok) shownFor = null;
    return ok;
  }

  function focusIn(index = 0) {
    if (!keyboard) return;
    const items = Zen.panelFocusables?.() || [];
    (items.at(index) || Zen.panelElement?.())?.focus?.();
  }

  async function show(tab, { keyboard: fromKeyboard = false } = {}) {
    const my = ++token;
    const s = settings();
    const current = () => my === token && shownFor === tab;
    ensurePanel(s);
    shownFor = tab;
    const card = cardForTab(tab, s);
    const loading = () => [makeUi(tab, s).header(Zen.tabTitle(tab)), h("div", { class: "zp-loading", role: "progressbar" })];

    if (!card) {
      cancelLoads();
      fill(loading());
      if (!openAt(tab, s)) return;
      const nodes = await renderPage(tab, s);
      if (current()) {
        fill(nodes);
        if (fromKeyboard) focusIn();
      }
      return;
    }

    // Show cached data at once (even if a little old) and refresh it behind the scenes.
    const def = Cards.get(card.type);
    const key = Cards.keyOf(card, s);
    cancelLoads(key);
    cache.ttl = s.refreshMs;
    const cached = cache.peek(key);
    const usable = cached && (cached.fresh || cached.age < MAX_STALE_MS) ? cached : null;
    fill(usable ? def.render(usable.value, makeUi(tab, s)) : loading());
    if (!openAt(tab, s)) return;
    if (fromKeyboard) focusIn();
    note("show", { card: card.type, data: usable ? (usable.fresh ? "fresh" : "stale") : "loading" });
    if (usable?.fresh) return;
    try {
      const data = await load(card, s);
      if (current()) {
        fill(def.render(data, makeUi(tab, s)));
        if (fromKeyboard) focusIn();
      }
    } catch (e) {
      if (e?.code === "aborted") return;
      if (e?.code !== "setup") console.warn("[Zen Peek]", card.type, e?.code || "", e?.message || e);
      note("error", { card: card.type, code: e?.code || "unknown" });
      // If old data is on screen, keep it rather than replacing it with an error.
      if (current() && !usable) {
        fill(renderError(tab, card, e, s));
        if (fromKeyboard) focusIn();
      }
    }
  }

  // Start fetching a card's data before its panel opens.
  function prefetch(tab, s) {
    const card = cardForTab(tab, s);
    if (!card) return;
    const key = Cards.keyOf(card, s);
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
    clearTimeout(hideTimer);
    const restore = keyboard?.restore;
    keyboard = null;
    const hadFocus = Zen.panelHasFocus?.();
    Zen.closePanel();
    cancelLoads();
    // Give focus back to where it was when the preview was opened from the keyboard.
    if (hadFocus && restore?.isConnected) restore.focus?.();
    note("hide", { reason });
  }

  // Is the pointer on its way from the Essential to the open preview?
  // (It must actually have moved: resting next to the Essential isn't "on its way".)
  function headingToPanel() {
    if (settings().close !== "smart" || !leftAt || !point) return false;
    if (Math.hypot(point.x - leftAt.x, point.y - leftAt.y) < 4) return false;
    const rect = Zen.panelRect?.();
    return !!rect && Core.headingToward(leftAt, point, rect);
  }
  const stillMoving = () => clock() - movedAt < 60;

  // "smart": close soon after leaving, but stay open (up to 1.2 s) while the
  // pointer moves toward the preview. "pause": close after 0.4 s.
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (keyboard) return; // opened from the keyboard: closes with Esc, the shortcut, or when focus leaves
    if (settings().close !== "smart" || !Zen.panelRect) {
      hideTimer = later(() => hide("left"), 400);
      return;
    }
    leftAt = point;
    leftTime = clock();
    const check = () => {
      if (headingToPanel() && clock() - leftTime < 1200) hideTimer = later(check, 100);
      else hide("left");
    };
    hideTimer = later(check, 180);
  }
  const cancelHide = () => clearTimeout(hideTimer);
  function onPanelEnter() {
    cancelHide();
    // Reached the preview: don't switch to an Essential crossed on the way.
    clearTimeout(showTimer);
    clearTimeout(prefetchTimer);
  }
  const onPanelLeave = () => scheduleHide();

  function onEnterEssential(tab) {
    cancelHide();
    clearTimeout(showTimer);
    clearTimeout(prefetchTimer);
    const s = settings();
    // Moving between Essentials while a preview is open switches quickly — unless
    // the pointer is only crossing them on its way to the preview: then it
    // switches once the pointer rests (or after 0.5 s at most).
    const heading = Zen.panelOpen() && headingToPanel();
    const delay = Zen.panelOpen() ? 60 : s.delay;
    // Only the hostname is logged: titles can contain e-mail addresses.
    note("enter", { host: hostOf(tab), delay, crossing: heading });
    if (heading) {
      const since = clock();
      const trySwitch = () => {
        if (stillMoving() && headingToPanel() && clock() - since < 500) showTimer = later(trySwitch, 80);
        else show(tab);
      };
      showTimer = later(trySwitch, 80);
      return;
    }
    // Start fetching once the pointer rests (not while it only passes over
    // icons), so the data is usually ready by the time the panel opens.
    prefetchTimer = later(() => prefetch(tab, s), Math.min(80, delay));
    showTimer = later(() => show(tab), delay);
  }

  function onLeaveEssential() {
    clearTimeout(showTimer);
    clearTimeout(prefetchTimer);
    scheduleHide();
  }

  // --- Keyboard ----------------------------------------------------------------
  // Shortcut: preview the focused (or first) Essential and move focus into it.
  // In the preview: ↑/↓ move between items, Enter opens, ←/→ switch Essential,
  // Esc closes and gives focus back.

  const SHORTCUTS = {
    "alt-shift-p": (e) => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey,
    "ctrl-alt-p": (e) => e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey,
  };

  function peekFromKeyboard() {
    const s = settings();
    if (Zen.panelOpen() && keyboard) {
      hide("shortcut");
      return;
    }
    const list = Zen.essentials(s.pinned);
    if (!list.length) return;
    const focused = Zen.focusedTab?.();
    const tab = list.includes(focused) ? focused : list[0];
    keyboard = { restore: document.activeElement };
    clearTimeout(showTimer);
    show(tab, { keyboard: true });
  }

  function onKey(e) {
    const s = settings();
    if (s.shortcut !== "off" && e.code === "KeyP" && SHORTCUTS[s.shortcut]?.(e)) {
      e.preventDefault();
      e.stopPropagation();
      peekFromKeyboard();
      return;
    }
    if (!Zen.panelOpen()) return;
    if (e.key === "Escape") {
      hide("escape");
      return;
    }
    if (!Zen.panelHasFocus?.()) return;
    const items = Zen.panelFocusables?.() || [];
    const at = items.indexOf(document.activeElement);
    let handled = true;
    if (e.key === "ArrowDown") items[Math.min(items.length - 1, at + 1)]?.focus();
    else if (e.key === "ArrowUp") items[Math.max(0, at - 1)]?.focus();
    else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items.at(-1)?.focus();
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && shownFor) {
      const list = Zen.essentials(s.pinned);
      const i = list.indexOf(shownFor);
      const next = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
      if (next && next !== shownFor) show(next, { keyboard: true });
    } else handled = false;
    if (handled) e.preventDefault();
  }

  // --- Badges on Essentials ----------------------------------------------------
  // The count comes from the card's data (Gmail unread, GitHub reviews +
  // notifications) or from the page title ("(3) Slack"). For Gmail, a live
  // count in the open tab's title wins over older fetched data.

  const badged = new Set();
  let badgeTimer = null;
  function scheduleBadges() {
    if (badgeTimer) return;
    badgeTimer = later(() => {
      badgeTimer = null;
      updateBadges();
    }, 50);
  }

  function badgeFor(tab, s) {
    const card = cardForTab(tab, s);
    const def = card && Cards.get(card.type);
    const live = Zen.isLoaded(tab) && (s.badgesTitle || def?.titleCounts) ? Core.parseTitleBadge(Zen.tabTitle(tab)) : null;
    let count = null;
    let dot = false;
    if (def?.count) {
      const hit = cache.peek(Cards.keyOf(card, s));
      if (hit && hit.age < MAX_STALE_MS) count = def.count(hit.value, s);
    }
    if (def?.titleCounts && live?.count != null) count = live.count;
    if (count === null && s.badgesTitle && live) {
      count = live.count;
      dot = live.dot;
    }
    const text = Core.badgeText(count ?? 0, { dot, style: s.badges });
    const label = text === null ? "" : count > 0 ? t("a11y.badge", { n: count }) : t("a11y.badge-dot");
    return { text, label };
  }

  function updateBadges() {
    const s = settings();
    const tabs = s.badges === "off" ? [] : Zen.essentials(s.pinned);
    const keep = new Set(tabs);
    for (const tab of badged) {
      if (!keep.has(tab) || !tab.isConnected) {
        Zen.setBadge(tab, null);
        badged.delete(tab);
      }
    }
    for (const tab of tabs) {
      const { text, label } = badgeFor(tab, s);
      Zen.setBadge(tab, text, label);
      if (text === null) badged.delete(tab);
      else badged.add(tab);
    }
  }

  // --- Background refresh -----------------------------------------------------
  // Keeps every Essential's card data fresh (for badges and instant previews),
  // only in the window you're using, at the "refresh" interval, when idle.
  // A failing service is retried less and less often (up to every 30 min);
  // a rate-limited one only after the time it gives.

  function backgroundTick() {
    const s = settings();
    updateBadges();
    if (!s.background || !Zen.windowActive?.()) return;
    cache.ttl = s.refreshMs;
    const seen = new Set();
    for (const tab of Zen.essentials(s.pinned)) {
      const card = cardForTab(tab, s);
      if (!card) continue;
      const key = Cards.keyOf(card, s);
      if (seen.has(key)) continue;
      seen.add(key);
      const f = failures.get(key);
      if ((f && Date.now() < f.until) || cache.get(key) || inflight.has(key)) continue;
      note("refresh", { card: card.type });
      load(card, s, { background: true }).catch(() => { /* recorded; retried later */ });
    }
  }
  const idle = (fn) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 5000 }) : fn());

  // --- Start / stop -------------------------------------------------------------

  // An older copy may still be running if Sine updated the mod without a restart.
  try {
    window.ZenPeek?.dispose?.();
  } catch (e) {
    console.warn("[Zen Peek] could not stop the previous copy", e);
  }

  function dispose() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    clearTimeout(prefetchTimer);
    cancelLoads(null, { all: true });
    token++;
    for (const f of cleanups.splice(0)) {
      try {
        f();
      } catch { /* already gone */ }
    }
    for (const tab of badged) Zen.setBadge(tab, null);
    badged.clear();
    Zen.removePanel?.();
  }

  // For the Browser Console and tests.
  window.ZenPeek = { show, hide, askCalendar, askGithub, load, cache, dispose, diagnostics, refresh: backgroundTick, updateBadges, flush: save };

  Zen.whenReady().then(() => {
    settings();
    ensurePanel();
    cleanups.push(Zen.watchHover({
      includePinned: () => settings().pinned,
      enter: onEnterEssential,
      leave: onLeaveEssential,
    }));
    cleanups.push(Zen.addTabMenuItems([
      { id: "calendar", label: () => t("menu.set-calendar"), command: askCalendar, show: (tab) => Cards.match(Zen.tabUrl(tab))?.type === "calendar" },
      { id: "github", label: () => t("menu.set-github"), command: askGithub, show: (tab) => Cards.match(Zen.tabUrl(tab))?.type === "github" },
    ]));
    cleanups.push(Zen.watchTabs((tab) => {
      if (tab) snapshots.delete(tab);
      scheduleBadges();
    }));
    cleanups.push(Zen.onPointerMove((p) => {
      point = p;
      movedAt = clock();
    }));
    window.addEventListener("keydown", onKey, true);
    cleanups.push(() => window.removeEventListener("keydown", onKey, true));
    const onActivate = () => later(() => idle(backgroundTick), 500);
    window.addEventListener("activate", onActivate);
    cleanups.push(() => window.removeEventListener("activate", onActivate));
    const interval = setInterval(() => idle(backgroundTick), 30_000);
    cleanups.push(() => clearInterval(interval));
    window.addEventListener("unload", dispose, { once: true });
    restore().finally(() => later(() => idle(backgroundTick), 3000));
    console.log("[Zen Peek] ready");
  }).catch((e) => console.error("Zen Peek failed to start", e));
})();
