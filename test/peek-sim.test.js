// Runs the real peek.uc.js (with core + sources) against a fake adapter and network.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { loadGlobals } from "./load.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal DOM-ish nodes so we can read what was rendered.
const node = (tag, props = {}, children = []) => ({ tag, props, children: children.filter(Boolean), text: props.text || "" });
const textOf = (n) => (n ? [n.text, ...(n.children || []).map(textOf)].filter(Boolean).join(" ") : "");
const findAll = (n, pred, out = []) => {
  if (!n) return out;
  if (pred(n)) out.push(n);
  for (const c of n.children || []) findAll(c, pred, out);
  return out;
};

// Options (defaults keep the original behaviour):
//  observable  — prefs support observers; setPref() changes a pref and notifies
//  fetchImpl   — replace the fake network: (url, init) => Response-like
//  openResult  — what the panel's openPanel() returns (false = refused)
//  tabs        — the Essentials (for badges and the background refresh)
//  active      — is this the window in use (background refresh runs only there)
//  bus         — share Services.obs between setups (= windows)
//  files       — a Map standing in for the profile folder (IOUtils)
//  panelRect   — where the open panel is (enables the "moving toward it" check)
//  locale      — Zen's language
const all = [];
afterEach(() => {
  for (const s of all.splice(0)) s.peek()?.dispose();
});

function makeBus() {
  const observers = new Set();
  return {
    addObserver: (o) => observers.add(o),
    removeObserver: (o) => observers.delete(o),
    notifyObservers: (subject, topic) => {
      for (const o of [...observers]) o.observe(subject, topic);
    },
  };
}

function setup({
  routes = {}, secrets = {}, prefs: givenPrefs = {}, observable = false, fetchImpl = null, openResult = undefined,
  tabs = [], active = true, bus = null, files = null, panelRect = null, locale = "en-US",
} = {}) {
  let prefs = { "gmail-count": 5, ...givenPrefs };
  let reads = 0;
  const observers = new Set();
  const pref = (k, d) => {
    reads++;
    return k.replace("zen.peek.", "") in prefs ? prefs[k.replace("zen.peek.", "")] : d;
  };
  const logs = [];
  let panelOpts = null;
  const calls = [];
  const opened = [];
  const snapshots = [];
  const menu = { added: 0, removed: 0 };
  const root = { children: [], replaceChildren(...c) { this.children = c; } };
  let open = false;
  let hover;
  let tabsChanged;
  let clickOutside;
  let pointer;
  const keydown = [];
  const Zen = {
    supported: true,
    whenReady: async () => {},
    watchHover(h) { hover = h; return () => {}; },
    watchTabs(cb) { tabsChanged = cb; return () => {}; },
    essentials: (includePinned) => tabs.filter((t) => !t.pinnedOnly || includePinned),
    setBadge(tab, text, label) {
      tab.badge = text ?? undefined;
      tab.badgeLabel = text === null || text === undefined ? undefined : label;
    },
    windowActive: () => active,
    onPointerMove(fn) { pointer = fn; return () => {}; },
    focusedTab: () => null,
    tabUrl: (t) => t.url,
    tabTitle: (t) => t.label,
    tabIcon: () => "",
    isLoaded: (t) => !!t.loaded,
    snapshot: async (tab) => {
      snapshots.push(tab.label);
      return node("canvas");
    },
    panel: (o) => ((panelOpts = o), {}),
    panelRoot: () => root,
    panelElement: () => null,
    panelOpen: () => open,
    panelRect: panelRect ? () => (open ? panelRect : null) : undefined,
    setPanelLabel() {},
    panelFocusables: () => [],
    panelHasFocus: () => false,
    openPanel() {
      if (openResult === false) return false;
      open = true;
      return openResult;
    },
    closePanel() { open = false; },
    lastPlacement: { style: "test" },
    panelStyle: "card",
    reposition() {},
    configure() {},
    removePanel() {},
    html: node,
    openLink: (url, tab, o) => opened.push({ url, tab: tab.label, ...o }),
    addTabMenuItems(items) {
      menu.added++;
      menu.items = items;
      return () => menu.removed++;
    },
    onClickOutside(fn) {
      clickOutside = fn;
      return () => {};
    },
  };
  const logins = Object.entries(secrets).map(([k, v]) => ({ origin: "chrome://zen-peek", httpRealm: k, password: v }));
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (fetchImpl) return fetchImpl(url, init);
    const r = typeof routes === "function" ? routes(url, init) : routes[url];
    if (r === undefined) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => r, json: async () => JSON.parse(r) };
  };
  const win = {
    addEventListener(type, fn) {
      if (type === "keydown") keydown.push(fn);
    },
    removeEventListener() {},
  };
  const io = files && {
    readJSON: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return JSON.parse(files.get(path));
    },
    writeJSON: async (path, value) => void files.set(path, JSON.stringify(value)),
    remove: async (path) => void files.delete(path),
  };
  const ctx = loadGlobals(["core.uc.js", "strings.uc.js", "sources.uc.js", "cards.uc.js"], {
    Intl, window: win, fetch: fetchFn, ZPZen: Zen, Ci: {}, Components: { Constructor: () => function () {} },
    document: { activeElement: null },
    structuredClone,
    setInterval: (...a) => {
      const id = setInterval(...a);
      id.unref?.();
      return id;
    },
    clearInterval,
    ...(io ? { IOUtils: io, PathUtils: { profileDir: "/profile", join: (...p) => p.join("/") } } : {}),
    console: { ...console, log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) },
    Services: {
      prefs: {
        getBoolPref: (k, d) => pref(k, d),
        getIntPref: (k, d) => (k.endsWith("delay") ? pref(k, 150) : pref(k, d)),
        getStringPref: (k, d) => pref(k, d),
        setStringPref: (k, v) => {
          prefs[k.replace("zen.peek.", "")] = v;
          for (const o of observers) o.observe(null, "nsPref:changed", k);
        },
        ...(observable ? { addObserver: (b, o) => observers.add(o), removeObserver: (b, o) => observers.delete(o) } : {}),
      },
      logins: { searchLoginsAsync: async ({ httpRealm }) => logins.filter((l) => l.httpRealm === httpRealm) },
      prompt: {},
      locale: { appLocaleAsBCP47: locale },
      ...(bus ? { obs: bus } : {}),
    },
  });
  vm.runInContext(readFileSync(new URL("../mod/peek.uc.js", import.meta.url), "utf8"), ctx);
  const api = {
    root, calls, opened, logs, ctx, snapshots, menu,
    isOpen: () => open,
    hover: () => hover,
    rendered: () => root.children.map(textOf).join(" | "),
    rows: () => findAll({ props: {}, children: root.children }, (n) => /(^| )zp-row( |$)/.test(n.props?.class || "")),
    buttons: () => findAll({ props: {}, children: root.children }, (n) => n.tag === "button" && !/zp-pin|zp-fab/.test(n.props?.class || "")),
    clickOutside: (target = null) => clickOutside(target),
    find: (pred) => findAll({ props: {}, children: root.children }, pred),
    reads: () => reads,
    panelOpts: () => panelOpts,
    peek: () => win.ZenPeek,
    tabsChanged: (tab) => tabsChanged(tab),
    move: (x, y) => pointer({ x, y }),
    key: (e) => keydown.forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, ...e })),
    setActive: (v) => (active = v),
    setPref(name, value) {
      prefs[name] = value;
      for (const o of observers) o.observe(null, "nsPref:changed", `zen.peek.${name}`);
    },
  };
  all.push(api);
  return api;
}

// GitHub: notifications (REST) and pull requests (GraphQL).
const reviewMe = { title: "Review me", number: 9, url: "https://github.com/a/b/pull/9", isDraft: false, updatedAt: new Date().toISOString(), repository: { nameWithOwner: "a/b" } };
function githubRoutes(url) {
  if (url.includes("/notifications")) return "[]";
  if (url.endsWith("/graphql")) {
    return JSON.stringify({ data: {
      reviews: { nodes: [reviewMe] },
      mine: { nodes: [{ ...reviewMe, title: "My fix", number: 3, reviewDecision: "APPROVED", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } }] },
    } });
  }
  return undefined;
}

const gmailTab = { label: "Gmail", url: "https://mail.google.com/mail/u/0/#inbox" };
const atom = `<feed><fullcount>2</fullcount><entry><title>Lunch?</title><issued>${new Date(Date.now() - 600000).toISOString()}</issued><author><name>Mert</name></author><link href="https://mail.google.com/mail/u/0/#inbox/1"/></entry></feed>`;

test("hover shows the Gmail card after the delay; click opens the mail", async () => {
  const s = setup({ routes: { "https://mail.google.com/mail/u/0/feed/atom": atom } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(50);
  assert.equal(s.isOpen(), false, "not before the delay");
  await sleep(200);
  assert.equal(s.isOpen(), true);
  assert.match(s.rendered(), /Gmail.*2 unread.*Mert.*Lunch\?/);
  const [first] = s.rows();
  first.props.onclick({ button: 0 });
  assert.deepEqual(s.opened[0], { url: "https://mail.google.com/mail/u/0/#inbox/1", tab: "Gmail", newTab: false });
  assert.equal(s.isOpen(), false, "clicking closes the preview");
});

test("results are cached between hovers", async () => {
  const s = setup({ routes: { "https://mail.google.com/mail/u/0/feed/atom": atom } });
  await sleep(5);
  for (let i = 0; i < 3; i++) {
    s.hover().enter(gmailTab);
    await sleep(220);
    s.hover().leave(gmailTab);
    await sleep(450);
  }
  assert.equal(s.calls.length, 1);
  assert.equal(s.isOpen(), false, "leaving hides the preview");
});

test("calendar without an address explains setup and offers a button", async () => {
  const s = setup();
  await sleep(5);
  s.hover().enter({ label: "Calendar", url: "https://calendar.google.com/calendar/r" });
  await sleep(250);
  assert.match(s.rendered(), /secret iCal address/);
  assert.equal(s.buttons().length, 1);
  assert.equal(s.calls.length, 0);
});

test("calendar card lists today's events from the stored address", async () => {
  const now = new Date();
  const p = (d) => String(d).padStart(2, "0");
  const stamp = (h) => `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(h)}0000`;
  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:1", "SUMMARY:Design review", `DTSTART:${stamp(10)}`, `DTEND:${stamp(11)}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const s = setup({ routes: { "https://cal/secret.ics": ics }, secrets: { calendar: "https://cal/secret.ics" } });
  await sleep(5);
  s.hover().enter({ label: "Calendar", url: "https://calendar.google.com/calendar/r" });
  await sleep(250);
  assert.match(s.rendered(), /Design review/);
});

test("github card shows review requests, my PRs and notifications", async () => {
  const s = setup({
    secrets: { github: "ghp_x" },
    routes: githubRoutes,
  });
  await sleep(5);
  s.hover().enter({ label: "GitHub", url: "https://github.com/" });
  await sleep(250);
  assert.match(s.rendered(), /Review requested · 1.*Review me.*a\/b #9.*Notifications.*No unread notifications/);
});

test("other sites show a snapshot only when the tab is loaded", async () => {
  const s = setup();
  await sleep(5);
  s.hover().enter({ label: "Notion", url: "https://www.notion.so/x", loaded: true });
  await sleep(250);
  assert.ok(s.root.children.some((n) => n.tag === "canvas"));
  s.hover().enter({ label: "Figma", url: "https://www.figma.com/x", loaded: false });
  await sleep(100);
  assert.ok(!s.root.children.some((n) => n.tag === "canvas"));
  assert.match(s.rendered(), /figma\.com · not loaded/);
});

test("a slow response for an old hover never replaces the current one", async () => {
  const s = setup({ routes: { "https://mail.google.com/mail/u/0/feed/atom": atom } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(160); // Gmail request starts
  s.hover().enter({ label: "Other", url: "https://example.com/", loaded: false }); // switch quickly
  await sleep(150);
  assert.match(s.rendered(), /example\.com/);
  assert.doesNotMatch(s.rendered(), /Lunch/);
});

const manyMails = `<feed><fullcount>6</fullcount>${Array.from({ length: 6 }, (_, i) => `<entry><title>Subject ${i}</title><summary>Body text ${i}</summary><issued>${new Date(Date.now() - i * 60000).toISOString()}</issued><author><name>Sender ${i}</name></author><link href="https://mail.google.com/mail/u/0/#inbox/${i}"/></entry>`).join("")}</feed>`;
const gmailRoute = { "https://mail.google.com/mail/u/0/feed/atom": manyMails };

test("settings: items per card and Gmail snippets", async () => {
  const s = setup({ routes: gmailRoute, prefs: { "gmail-count": 3, "gmail-snippets": true } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.equal(s.rows().length, 3);
  assert.match(s.rendered(), /Subject 0.*Body text 0/);
});

test("settings: snippets are off by default", async () => {
  const s = setup({ routes: gmailRoute });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.equal(s.rows().length, 5);
  assert.doesNotMatch(s.rendered(), /Body text/);
});

test("settings: a card turned off shows the page instead", async () => {
  const s = setup({ routes: gmailRoute, prefs: { "card-gmail": false } });
  await sleep(5);
  s.hover().enter({ ...gmailTab, loaded: true });
  await sleep(250);
  assert.equal(s.calls.length, 0, "Gmail not fetched");
  assert.ok(s.root.children.some((n) => n.tag === "canvas"), "page snapshot shown");
});

test("settings: links open in a new tab when chosen", async () => {
  const s = setup({ routes: gmailRoute, prefs: { "open-links": "new" } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  s.rows()[0].props.onclick({ button: 0 });
  assert.equal(s.opened[0].newTab, true);
});

test("settings: calendar hides past events and the next event", async () => {
  const now = new Date();
  const p = (d) => String(d).padStart(2, "0");
  const stamp = (d, h) => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(h)}0000`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const ev = (uid, t, day, h1, h2) => ["BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${t}`, `DTSTART:${stamp(day, h1)}`, `DTEND:${stamp(day, h2)}`, "END:VEVENT"];
  const ics = ["BEGIN:VCALENDAR", ...ev("1", "Early meeting", now, 0, 0 + 1), ...ev("2", "Tomorrow thing", tomorrow, 10, 11), "END:VCALENDAR"].join("\r\n");
  const base = { routes: { "https://cal/s.ics": ics }, secrets: { calendar: "https://cal/s.ics" } };
  const calTab = { label: "Calendar", url: "https://calendar.google.com/calendar/r" };

  let s = setup(base);
  await sleep(5);
  s.hover().enter(calTab);
  await sleep(250);
  if (now.getHours() >= 1) assert.match(s.rendered(), /Early meeting/);
  assert.match(s.rendered(), /Next.*Tomorrow thing/);

  s = setup({ ...base, prefs: { "calendar-past": false, "calendar-next": false } });
  await sleep(5);
  s.hover().enter(calTab);
  await sleep(250);
  if (now.getHours() >= 1) assert.doesNotMatch(s.rendered(), /Early meeting/);
  assert.doesNotMatch(s.rendered(), /Tomorrow thing/);
});

test("settings: GitHub sections can be turned off", async () => {
  const s = setup({ routes: githubRoutes, secrets: { github: "t" }, prefs: { "github-reviews": false, "github-mine": false, "github-notifications": false } });
  await sleep(5);
  s.hover().enter({ label: "GitHub", url: "https://github.com/" });
  await sleep(250);
  assert.doesNotMatch(s.rendered(), /Review me|Notifications/);
  assert.match(s.rendered(), /turned off/);
});

// --- Classic-popup fixes: settings cache, prefetch, cancelling, stale data, diagnostics ---

const atomWith = (subject) => `<feed><fullcount>1</fullcount><entry><title>${subject}</title><issued>${new Date().toISOString()}</issued><author><name>Ada</name></author><link href="https://mail.google.com/mail/u/0/#inbox/9"/></entry></feed>`;
const GMAIL_FEED = "https://mail.google.com/mail/u/0/feed/atom";

// A network that answers only when told to, and honours AbortSignal like fetch().
function controllableNetwork() {
  const pending = [];
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      const req = { url, signal: init?.signal, resolve, reject };
      pending.push(req);
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const respond = (body, i = pending.length - 1) =>
    pending[i].resolve({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
  return { pending, fetchImpl, respond };
}

test("settings are read once and refreshed when a preference changes", async () => {
  const s = setup({ observable: true, routes: { [GMAIL_FEED]: manyMails } });
  await sleep(5);
  const afterStart = s.reads();
  for (let i = 0; i < 3; i++) {
    s.hover().enter(gmailTab);
    await sleep(220);
    s.hover().leave(gmailTab);
    await sleep(450);
  }
  assert.equal(s.reads(), afterStart, "no preference reads while hovering");
  assert.equal(s.rows().length, 5);

  s.setPref("gmail-count", 3); // observer drops the cache; next hover reads again
  s.hover().enter(gmailTab);
  await sleep(220);
  assert.ok(s.reads() > afterStart);
  assert.equal(s.rows().length, 3);
});

test("data starts loading while the hover delay runs, and is shown without a placeholder", async () => {
  const net = controllableNetwork();
  const s = setup({ fetchImpl: net.fetchImpl, prefs: { delay: 300 } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(120);
  assert.equal(net.pending.length, 1, "request started during the delay");
  assert.equal(s.isOpen(), false, "panel not open yet");
  net.respond(atomWith("Ready before open"));
  await sleep(250);
  assert.equal(s.isOpen(), true);
  assert.match(s.rendered(), /Ready before open/);
  assert.doesNotMatch(JSON.stringify(s.root.children.map((n) => n.props.class)), /zp-loading/, "no loading placeholder");
});

test("passing quickly over an Essential doesn't start a request", async () => {
  const net = controllableNetwork();
  const s = setup({ fetchImpl: net.fetchImpl, prefs: { delay: 300 } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(30);
  s.hover().leave(gmailTab);
  await sleep(120);
  assert.equal(net.pending.length, 0);
});

test("leaving cancels the request; coming back starts a new one", async () => {
  const net = controllableNetwork();
  const s = setup({ fetchImpl: net.fetchImpl });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(220); // panel open, request pending
  assert.equal(s.isOpen(), true);
  s.hover().leave(gmailTab);
  await sleep(450); // hide
  assert.equal(s.isOpen(), false);
  assert.equal(net.pending[0].signal.aborted, true, "request cancelled");
  assert.doesNotMatch(s.logs.join("\n"), /Zen Peek\] gmail/, "a cancel isn't reported as an error");

  s.hover().enter(gmailTab);
  await sleep(220);
  assert.equal(net.pending.length, 2, "fresh request after coming back");
  net.respond(atomWith("Second try"));
  await sleep(20);
  assert.match(s.rendered(), /Second try/);
});

test("moving to another Essential cancels the previous Essential's request", async () => {
  const net = controllableNetwork();
  const s = setup({ fetchImpl: net.fetchImpl });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(220);
  s.hover().enter({ label: "HN", url: "https://news.ycombinator.com/" });
  await sleep(100);
  assert.equal(net.pending[0].signal.aborted, true);
  assert.equal(net.pending[1].url, "https://hacker-news.firebaseio.com/v0/topstories.json");
});

test("old data is shown instantly and replaced when the refresh arrives", async () => {
  const net = controllableNetwork();
  const s = setup({ fetchImpl: net.fetchImpl });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(220);
  net.respond(atomWith("Old subject"));
  await sleep(20);
  s.hover().leave(gmailTab);
  await sleep(450);
  // Age the cached entry: past the refresh interval, within the stale window.
  for (const e of s.peek().cache.map.values()) e.at -= 5 * 60_000;

  s.hover().enter(gmailTab);
  await sleep(220);
  assert.match(s.rendered(), /Old subject/, "stale data shown immediately");
  net.respond(atomWith("New subject"));
  await sleep(20);
  assert.match(s.rendered(), /New subject/, "refreshed in place");
});

test("if a refresh fails, the old data stays on screen", async () => {
  let fail = false;
  const s = setup({
    fetchImpl: async () => (fail ? { ok: false, status: 500, text: async () => "" } : { ok: true, status: 200, text: async () => atomWith("Keep me") }),
  });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(220);
  s.hover().leave(gmailTab);
  await sleep(450);
  for (const e of s.peek().cache.map.values()) e.at -= 5 * 60_000;
  fail = true;
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.match(s.rendered(), /Keep me/);
  assert.doesNotMatch(s.rendered(), /service returned an error/);
});

test("very old data is not shown; a loading state appears instead", async () => {
  const net = controllableNetwork();
  const s = setup({ fetchImpl: net.fetchImpl });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(220);
  net.respond(atomWith("Ancient"));
  await sleep(20);
  s.hover().leave(gmailTab);
  await sleep(450);
  for (const e of s.peek().cache.map.values()) e.at -= 2 * 60 * 60_000; // 2 hours
  s.hover().enter(gmailTab);
  await sleep(220);
  assert.doesNotMatch(s.rendered(), /Ancient/);
});

test("classic: if the Essential isn't visible, nothing opens and nothing breaks", async () => {
  const s = setup({ openResult: false, routes: { [GMAIL_FEED]: manyMails } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.equal(s.isOpen(), false);
  const d = s.peek().diagnostics();
  assert.ok(d.events.some((e) => e.event === "open-refused"));
});

test("classic: when the Essential disappears while open, the preview closes and requests stop", async () => {
  const net = controllableNetwork();
  const s = setup({ fetchImpl: net.fetchImpl });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(220);
  assert.equal(s.isOpen(), true);
  s.panelOpts().onLost(); // what the adapter calls when the Essential is hidden
  assert.equal(s.isOpen(), false);
  assert.equal(net.pending[0].signal.aborted, true);
  assert.ok(s.peek().diagnostics().events.some((e) => e.event === "hide" && e.reason === "essential-hidden"));
});

test("diagnostics: recent events are kept; debug logging only when switched on", async () => {
  const s = setup({ routes: { [GMAIL_FEED]: manyMails } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  const d = s.peek().diagnostics();
  const names = d.events.map((e) => e.event);
  for (const n of ["enter", "prefetch", "open", "show"]) assert.ok(names.includes(n), n);
  assert.equal(d.lastPlacement.style, "test");
  assert.ok(!s.logs.some((l) => l.includes("debug:")), "quiet by default");
  assert.doesNotMatch(JSON.stringify(d), /ghp_|password/i, "no secrets in diagnostics");
  assert.ok(d.events.some((e) => e.event === "enter" && e.host === "mail.google.com"), "hostname logged");
  assert.doesNotMatch(JSON.stringify(d.events), /"title"/, "tab titles are not logged");

  const s2 = setup({ routes: { [GMAIL_FEED]: manyMails }, prefs: { debug: true } });
  await sleep(5);
  s2.hover().enter(gmailTab);
  await sleep(250);
  assert.ok(s2.logs.some((l) => l.includes("[Zen Peek] debug: open")));
});

// --- Badges, background refresh, sharing, saving, keyboard, Join, smart closing ---

const essential = (label, url, extra = {}) => ({ label, url, loaded: false, ...extra });
const atomCount = (n) => `<feed><fullcount>${n}</fullcount><entry><title>Hi</title><issued>${new Date().toISOString()}</issued><author><name>Ada</name></author><link href="https://mail.google.com/mail/u/0/#inbox/1"/></entry></feed>`;

test("badges: the background refresh fetches each Essential's data and shows its unread count", async () => {
  const gmail = essential("Gmail", "https://mail.google.com/mail/u/0/");
  const notion = essential("Notion", "https://www.notion.so/");
  const s = setup({ routes: { [GMAIL_FEED]: atomCount(4) }, tabs: [gmail, notion], prefs: { badges: "count" } });
  await sleep(5);
  s.peek().refresh();
  await sleep(80);
  assert.equal(s.calls.length, 1);
  assert.equal(gmail.badge, "4");
  assert.equal(gmail.badgeLabel, "4 unread");
  assert.equal(notion.badge, undefined, "no badge without a count");
  assert.equal(s.isOpen(), false, "nothing opens");
});

test("badges: counts in page titles (chat apps), dot and off styles", async () => {
  const wa = essential("(3) WhatsApp", "https://web.whatsapp.com/", { loaded: true });
  const discord = essential("• Discord | Friends", "https://discord.com/app", { loaded: true });
  const sleeping = essential("(5) Messenger", "https://www.messenger.com/", { loaded: false });
  const s = setup({ observable: true, tabs: [wa, discord, sleeping], prefs: { badges: "count" } });
  await sleep(5);
  s.peek().updateBadges();
  assert.equal(wa.badge, "3");
  assert.equal(discord.badge, "", "unread without a number: a dot");
  assert.equal(sleeping.badge, undefined, "an unloaded tab's title is old");

  wa.label = "WhatsApp"; // messages read
  s.tabsChanged(wa);
  await sleep(80);
  assert.equal(wa.badge, undefined);

  wa.label = "(120) WhatsApp";
  s.setPref("badges", "dot");
  await sleep(200);
  assert.equal(wa.badge, "", "dot style");
  s.setPref("badges", "count");
  await sleep(200);
  assert.equal(wa.badge, "99+");
  s.setPref("badges-title", false);
  await sleep(200);
  assert.equal(wa.badge, undefined, "reading titles can be turned off");
  s.setPref("badges-title", true);
  s.setPref("badges", "off");
  await sleep(200);
  assert.equal(wa.badge, undefined, "badges off removes them");
});

test("badges: an open Gmail tab's live title count wins over older fetched data", async () => {
  const gmail = essential("Inbox (1) - me@gmail.com - Gmail", "https://mail.google.com/mail/u/0/", { loaded: true });
  const s = setup({ routes: { [GMAIL_FEED]: atomCount(4) }, tabs: [gmail], prefs: { badges: "count" } });
  await sleep(5);
  s.peek().refresh();
  await sleep(80);
  assert.equal(gmail.badge, "1");
  gmail.label = "Starred - me@gmail.com - Gmail"; // another folder: no count in the title
  s.tabsChanged(gmail);
  await sleep(80);
  assert.equal(gmail.badge, "4", "falls back to the fetched count");
});

test("badges: removed when the mod stops", async () => {
  const wa = essential("(3) WhatsApp", "https://web.whatsapp.com/", { loaded: true });
  const s = setup({ tabs: [wa] });
  await sleep(5);
  s.peek().updateBadges();
  assert.equal(wa.badge, "", "a dot by default, like Arc");
  assert.equal(wa.badgeLabel, "3 unread", "screen readers still hear the number");
  s.peek().dispose();
  assert.equal(wa.badge, undefined);
  assert.equal(s.menu.added, 1);
  assert.equal(s.menu.removed, 1, "the right-click menu items are removed too");
});

test("background refresh: only in the window in use; a failing service is retried later, not every time", async () => {
  const gmail = essential("Gmail", "https://mail.google.com/mail/u/0/");
  let fail = true;
  const s = setup({
    tabs: [gmail], active: false,
    fetchImpl: async () => (fail ? { ok: false, status: 500, text: async () => "" } : { ok: true, status: 200, text: async () => atomCount(2) }),
  });
  await sleep(5);
  s.peek().refresh();
  await sleep(30);
  assert.equal(s.calls.length, 0, "inactive window: no requests");
  s.setActive(true);
  s.peek().refresh();
  await sleep(30);
  assert.equal(s.calls.length, 1);
  fail = false;
  s.peek().refresh();
  await sleep(30);
  assert.equal(s.calls.length, 1, "waits before retrying a failed service");
  const backoff = s.peek().diagnostics().backoff[0];
  assert.equal(backoff.code, "server");
  assert.ok(backoff.waitS > 30);
});

test("rate limits: the message says when, and no request is made until then", async () => {
  const s = setup({
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: (k) => (k === "retry-after" ? "600" : null) }, text: async () => "" }),
  });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.match(s.rendered(), /Too many requests for now\. Trying again at/);
  assert.equal(s.buttons().length, 0, "no retry button");
  s.hover().leave(gmailTab);
  await sleep(450);
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.equal(s.calls.length, 1, "still waiting: no second request");
});

test("a service that doesn't answer shows a timeout with a Try again button", async () => {
  let hang = true;
  const s = setup({
    prefs: { timeout: 3 },
    fetchImpl: (url, init) => (hang
      ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))))
      : Promise.resolve({ ok: true, status: 200, text: async () => atomWith("Back again") })),
  });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(3300);
  assert.match(s.rendered(), /didn't answer in time/);
  const [retry] = s.buttons();
  assert.match(retry.text, /Try again/);
  hang = false;
  retry.props.onclick();
  await sleep(50);
  assert.match(s.rendered(), /Back again/);
});

test("windows share data: what one window fetched, another shows without asking again", async () => {
  const bus = makeBus();
  const a = setup({ bus, routes: { [GMAIL_FEED]: atomWith("Shared mail") } });
  const b = setup({ bus, routes: { [GMAIL_FEED]: atomWith("Shared mail") } });
  await sleep(5);
  a.hover().enter(gmailTab);
  await sleep(250);
  assert.equal(a.calls.length, 1);
  b.hover().enter(gmailTab);
  await sleep(250);
  assert.equal(b.calls.length, 0, "the other window didn't fetch");
  assert.match(b.rendered(), /Shared mail/);
});

test("previews are kept between restarts, and forgotten when that's turned off", async () => {
  const files = new Map();
  const a = setup({ files, routes: { [GMAIL_FEED]: atomWith("Remembered") } });
  await sleep(5);
  a.hover().enter(gmailTab);
  await sleep(250);
  await a.peek().flush();
  const saved = files.get("/profile/zen-peek-cache.json");
  assert.ok(saved, "written to the profile");
  assert.match(saved, /\$date/, "dates kept");
  assert.doesNotMatch(saved, /chrome:\/\/zen-peek|password|token/i, "no secrets");
  a.peek().dispose();

  // "Restart": a new window reads the file and shows the data without fetching.
  const b = setup({ files, observable: true, fetchImpl: () => new Promise(() => {}) });
  await sleep(20);
  b.hover().enter(gmailTab);
  await sleep(250);
  assert.match(b.rendered(), /Remembered/);

  b.setPref("persist", false);
  await sleep(200);
  assert.equal(files.size, 0, "file removed");
});

test("page snapshots are reused for a few seconds, and retaken after the tab changes", async () => {
  const notion = { label: "Notion", url: "https://www.notion.so/x", loaded: true };
  const s = setup();
  await sleep(5);
  for (let i = 0; i < 2; i++) {
    s.hover().enter(notion);
    await sleep(220);
    s.hover().leave(notion);
    await sleep(450);
  }
  assert.equal(s.snapshots.length, 1);
  s.tabsChanged(notion);
  s.hover().enter(notion);
  await sleep(220);
  assert.equal(s.snapshots.length, 2);
});

test("calendar: a Join button for a meeting that's about to start opens it in a new tab", async () => {
  const now = new Date();
  const p = (d) => String(d).padStart(2, "0");
  const utc = (d) => `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
  const soon = new Date(now.getTime() + 5 * 60000);
  const later = new Date(now.getTime() + 25 * 60000);
  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:1", "SUMMARY:Standup", `DTSTART:${utc(soon)}`, `DTEND:${utc(later)}`,
    "LOCATION:https://meet.google.com/abc-defg-hij", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const s = setup({ routes: { "https://cal/s.ics": ics }, secrets: { calendar: "https://cal/s.ics" } });
  await sleep(5);
  s.hover().enter({ label: "Calendar", url: "https://calendar.google.com/calendar/r" });
  await sleep(250);
  if (soon.getDate() !== now.getDate()) return; // just before midnight: the event is tomorrow
  const [join] = s.find((n) => /zp-action/.test(n.props.class || ""));
  assert.ok(join, "Join button shown");
  assert.equal(join.props["aria-label"], "Join on Google Meet");
  assert.doesNotMatch(s.rendered(), /Standup \| .*meet\.google\.com/, "the link isn't repeated as the location");
  let stopped = false;
  join.props.onclick({ button: 0, stopPropagation: () => (stopped = true) });
  assert.ok(stopped);
  assert.deepEqual(s.opened[0], { url: "https://meet.google.com/abc-defg-hij", tab: "Calendar", newTab: true });
});

test("github: CI state and review status of my pull requests", async () => {
  const s = setup({ routes: githubRoutes, secrets: { github: "t" } });
  await sleep(5);
  s.hover().enter({ label: "GitHub", url: "https://github.com/" });
  await sleep(250);
  assert.match(s.rendered(), /Your pull requests.*My fix.*approved · ✗/);
  const mine = s.rows().find((r) => /My fix/.test(textOf(r)));
  assert.equal(mine.props["aria-label"], "My fix, a/b #3, approved, Checks failing");
  assert.equal(s.calls.length, 2, "notifications + one GraphQL request");
});

test("language: follows Zen (Turkish), English when there's no translation", async () => {
  const s = setup({ locale: "tr-TR", routes: { [GMAIL_FEED]: atomCount(2) } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.match(s.rendered(), /2 okunmamış/);
  const en = setup({ locale: "de-DE", routes: { [GMAIL_FEED]: atomCount(2) } });
  await sleep(5);
  en.hover().enter(gmailTab);
  await sleep(250);
  assert.match(en.rendered(), /2 unread/);
});

test("smart closing: stays open while the mouse moves toward the preview, closes when it goes elsewhere", async () => {
  const panelRect = { left: 220, right: 540, top: 40, bottom: 300 };
  const s = setup({ panelRect, routes: { [GMAIL_FEED]: manyMails } });
  await sleep(5);
  s.move(100, 60);
  s.hover().enter(gmailTab);
  await sleep(250);
  s.hover().leave(gmailTab);
  s.move(150, 80); // diagonally toward the card
  await sleep(450);
  assert.equal(s.isOpen(), true, "kept open on the way");
  s.move(60, 400); // away
  await sleep(250);
  assert.equal(s.isOpen(), false);

  // Default "pause" behaviour without the check.
  const p = setup({ panelRect, prefs: { close: "pause" }, routes: { [GMAIL_FEED]: manyMails } });
  await sleep(5);
  p.move(100, 60);
  p.hover().enter(gmailTab);
  await sleep(250);
  p.hover().leave(gmailTab);
  p.move(150, 80);
  await sleep(450);
  assert.equal(p.isOpen(), false);
});

test("smart closing: crossing another Essential on the way to the preview doesn't switch to it", async () => {
  const panelRect = { left: 220, right: 540, top: 40, bottom: 300 };
  const s = setup({ panelRect, routes: { [GMAIL_FEED]: manyMails } });
  await sleep(5);
  s.move(100, 60);
  s.hover().enter(gmailTab);
  await sleep(250);
  s.hover().leave(gmailTab);
  s.move(130, 70);
  const hn = { label: "HN", url: "https://news.ycombinator.com/" };
  s.hover().enter(hn); // passing over it…
  for (let x = 140; x < 220; x += 16) {
    s.move(x, 60 + (x - 100) / 3); // …still moving toward the preview
    await sleep(25);
  }
  s.panelOpts().onEnter(); // reached the preview
  await sleep(300);
  assert.match(s.rendered(), /Gmail/, "still the Gmail preview");
  assert.equal(s.calls.filter((c) => c.url.includes("hacker-news")).length, 0, "nothing fetched for the crossed Essential");

  // Resting on an Essential (no movement) switches to it right away.
  s.hover().leave(gmailTab);
  s.move(110, 64);
  s.hover().enter(hn);
  await sleep(200);
  assert.match(s.rendered(), /^HN/, "switched to the Essential it rests on");
});

test("keyboard: the shortcut previews the first Essential; Esc closes", async () => {
  const gmail = essential("Gmail", "https://mail.google.com/mail/u/0/");
  const s = setup({ tabs: [gmail], routes: { [GMAIL_FEED]: manyMails }, observable: true });
  await sleep(5);
  s.key({ code: "KeyP", key: "P", altKey: true, shiftKey: true });
  await sleep(50);
  assert.equal(s.isOpen(), true);
  assert.match(s.rendered(), /Gmail/);
  s.hover().leave(gmail); // the mouse moving doesn't close a keyboard preview
  await sleep(500);
  assert.equal(s.isOpen(), true);
  s.key({ code: "KeyP", key: "P", altKey: true, shiftKey: true });
  await sleep(10);
  assert.equal(s.isOpen(), false, "the shortcut again closes it");
  s.key({ code: "KeyP", key: "P", altKey: true, shiftKey: true });
  await sleep(50);
  s.key({ key: "Escape" });
  assert.equal(s.isOpen(), false);
  s.setPref("shortcut", "off");
  await sleep(150);
  s.key({ code: "KeyP", key: "P", altKey: true, shiftKey: true });
  await sleep(50);
  assert.equal(s.isOpen(), false, "shortcut can be turned off");
});

test("rows are keyboard-accessible links", async () => {
  const s = setup({ routes: { [GMAIL_FEED]: manyMails } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  const [row] = s.rows();
  assert.equal(row.props.role, "link");
  assert.equal(row.props.tabindex, "0");
  let prevented = false;
  row.props.onkeydown({ key: "Enter", preventDefault: () => (prevented = true) });
  assert.ok(prevented);
  assert.equal(s.opened.length, 1);
  row.props.onauxclick({ button: 1 });
  assert.equal(s.opened[1].newTab, true, "middle click opens a new tab");
});

// --- Pages, pin, "show as", mark as read, weather, "+", cards from other mods ---

test("gmail: one scrolling list, as many mails as chosen, plus a + for a new mail", async () => {
  const s = setup({ routes: gmailRoute, prefs: { "gmail-count": 10 } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.equal(s.rows().length, 6, "all six mails, no pages");
  assert.equal(s.find((n) => /zp-pin|zp-page/.test(n.props?.class || "")).length, 0);
  const [fab] = s.find((n) => n.props?.class === "zp-fab");
  fab.props.onclick({ button: 0 });
  assert.match(s.opened.at(-1).url, /compose=new/);
});

test("settings: the + button and Show more can be turned off", async () => {
  const s = setup({ routes: gmailRoute, prefs: { "create-button": false } });
  await sleep(5);
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.equal(s.find((n) => n.props?.class === "zp-fab").length, 0);
  const hn = setup({
    prefs: { items: 2, "show-more": false },
    routes: (url) => (url.endsWith("topstories.json") ? "[1,2,3,4]" : JSON.stringify({ id: 1, title: "Story", score: 1, descendants: 0 })),
  });
  await sleep(5);
  hn.hover().enter({ label: "HN", url: "https://news.ycombinator.com/" });
  await sleep(250);
  assert.equal(hn.rows().length, 2);
  assert.equal(hn.find((n) => n.props?.class === "zp-more").length, 0);
});

test("show as: an Essential can use another card, or just the page", async () => {
  const tab = { label: "Forecast", url: "https://example.com/forecast", loaded: true };
  const s = setup({ observable: true, prefs: { "weather-location": "Istanbul" } });
  await sleep(5);
  const showAs = s.menu.items.find((i) => i.id === "show-as");
  showAs.submenu(tab).find((o) => /Weather/.test(o.label)).command();
  s.hover().enter(tab);
  await sleep(250);
  assert.ok(s.calls.some((c) => c.url.includes("geocoding-api.open-meteo.com")), "the weather card loads");
  showAs.submenu(tab).find((o) => o.label === "Page preview").command();
  s.hover().leave(tab);
  await sleep(500);
  s.hover().enter(gmailTab);
  await sleep(250);
  assert.ok(showAs.submenu(gmailTab).find((o) => o.label === "Automatic").checked);
});

test("github: marking a notification as read removes it at once", async () => {
  const routes = (url, init) => {
    if (url.includes("/notifications/threads/")) return init.method === "PATCH" ? "" : undefined;
    if (url.includes("/notifications")) {
      return JSON.stringify([{ id: "42", reason: "mention", updated_at: new Date().toISOString(), repository: { full_name: "a/b" }, subject: { title: "Ping", type: "Issue", url: "https://api.github.com/repos/a/b/issues/1" } }]);
    }
    if (url.endsWith("/graphql")) return JSON.stringify({ data: {} });
    return undefined;
  };
  const s = setup({ routes, secrets: { github: "t" } });
  await sleep(5);
  s.hover().enter({ label: "GitHub", url: "https://github.com/" });
  await sleep(250);
  assert.match(s.rendered(), /Ping/);
  const [read] = s.find((n) => /zp-action-quiet/.test(n.props?.class || ""));
  await read.props.onclick({ stopPropagation() {}, currentTarget: {} });
  assert.ok(s.calls.some((c) => c.url.endsWith("/notifications/threads/42") && c.init.method === "PATCH"));
  assert.doesNotMatch(s.rendered(), /Ping/);
  assert.match(s.rendered(), /No unread notifications/);
});

test("cards from other mods: added, shown, and a broken one can't break the preview", async () => {
  const s = setup();
  await sleep(5);
  const api = s.peek();
  assert.throws(() => api.registerCard({ type: "gmail", match: () => null, load() {}, render() {} }), /own cards/);
  const remove = api.registerCard({
    type: "todo",
    name: "To-do",
    match: (u) => (u.hostname === "todo.example" ? { type: "todo" } : null),
    load: async () => ({ items: ["Buy milk"] }),
    render: (d, ui) => [ui.header("To-do"), ...d.items.map((x) => ui.row({ primary: x }))],
  });
  s.hover().enter({ label: "Todo", url: "https://todo.example/" });
  await sleep(250);
  assert.match(s.rendered(), /To-do \| Buy milk/);
  remove();
  api.registerCard({ type: "broken", match: (u) => (u.hostname === "broken.example" ? { type: "broken" } : null), load: async () => ({}), render: () => { throw new Error("oops"); } });
  s.hover().enter({ label: "Broken", url: "https://broken.example/" });
  await sleep(250);
  assert.match(s.rendered(), /Couldn't load this preview/);
});
