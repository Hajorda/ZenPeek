// Runs the real peek.uc.js (with core + sources) against a fake adapter and network.
import { test } from "node:test";
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

function setup({ routes = {}, secrets = {} } = {}) {
  const calls = [];
  const opened = [];
  const root = { children: [], replaceChildren(...c) { this.children = c; } };
  let open = false;
  let hover;
  const Zen = {
    supported: true,
    whenReady: async () => {},
    watchHover(h) { hover = h; return () => {}; },
    tabUrl: (t) => t.url,
    tabTitle: (t) => t.label,
    tabIcon: () => "",
    isLoaded: (t) => !!t.loaded,
    snapshot: async () => node("canvas"),
    panel: () => ({}),
    panelRoot: () => root,
    panelOpen: () => open,
    openPanel() { open = true; },
    closePanel() { open = false; },
    html: node,
    openLink: (url, tab, o) => opened.push({ url, tab: tab.label, ...o }),
    addTabMenuItems() {},
  };
  const logins = Object.entries(secrets).map(([k, v]) => ({ origin: "chrome://zen-peek", httpRealm: k, password: v }));
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (r === undefined) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => r, json: async () => JSON.parse(r) };
  };
  const win = { addEventListener() {}, removeEventListener() {} };
  const ctx = loadGlobals(["core.uc.js", "sources.uc.js"], {
    Intl, window: win, fetch: fetchFn, ZPZen: Zen, Ci: {}, Components: { Constructor: () => function () {} },
    Services: {
      prefs: { getBoolPref: (k, d) => d, getIntPref: (k, d) => (k.endsWith("delay") ? 150 : d), getStringPref: (k, d) => d },
      logins: { searchLoginsAsync: async ({ httpRealm }) => logins.filter((l) => l.httpRealm === httpRealm) },
      prompt: {},
    },
  });
  vm.runInContext(readFileSync(new URL("../mod/peek.uc.js", import.meta.url), "utf8"), ctx);
  return { root, calls, opened, isOpen: () => open, hover: () => hover, rendered: () => root.children.map(textOf).join(" | "), rows: () => root.children.filter((n) => /zp-row/.test(n.props.class || "")) };
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
    await sleep(300);
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
  assert.equal(findAll({ children: s.root.children }, (n) => n.tag === "button").length, 1);
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
    routes: new Proxy({}, { get: (_, url) => {
      if (typeof url !== "string") return undefined;
      if (url.includes("/notifications")) return "[]";
      if (url.includes("review-requested")) return JSON.stringify({ items: [{ number: 9, title: "Review me", html_url: "https://github.com/a/b/pull/9", repository_url: "https://api.github.com/repos/a/b", updated_at: new Date().toISOString() }] });
      return JSON.stringify({ items: [] });
    } }),
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
