import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "./load.js";

const ctx = loadGlobals(["core.uc.js", "sources.uc.js"], { Intl });
const S = ctx.ZPSources;

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = typeof routes === "function" ? routes(url) : routes[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    const body = r.body ?? r;
    return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const atom = `<feed><fullcount>7</fullcount>${Array.from({ length: 7 }, (_, i) => `<entry><title>Mail ${i}</title><issued>2026-09-29T0${i}:00:00Z</issued><author><name>P${i}</name></author><link href="https://mail.google.com/x${i}"/></entry>`).join("")}</feed>`;

test("gmail: account path, cookies included, limited to 5", async () => {
  const f = fakeFetch({ "https://mail.google.com/mail/u/1/feed/atom": atom });
  const r = await S.gmail({ fetchFn: f, account: 1 });
  assert.equal(r.unread, 7);
  assert.equal(r.mails.length, 5);
  assert.equal(f.calls[0].init.credentials, "include");
});

test("gmail: a login page means signed out", async () => {
  const f = fakeFetch({ "https://mail.google.com/mail/u/0/feed/atom": "<html>Sign in</html>" });
  await assert.rejects(S.gmail({ fetchFn: f }), (e) => e.code === "signed-out");
  await assert.rejects(S.gmail({ fetchFn: fakeFetch({ "https://mail.google.com/mail/u/0/feed/atom": { status: 401, body: "" } }) }), (e) => e.code === "auth");
  await assert.rejects(S.gmail({ fetchFn: fakeFetch(() => new TypeError("offline")) }), (e) => e.code === "network");
});

const cal = (lines) => ["BEGIN:VCALENDAR", "X-WR-TIMEZONE:Europe/Istanbul", ...lines, "END:VCALENDAR"].join("\r\n");
const event = (uid, summary, start, end) => ["BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${summary}`, `DTSTART;TZID=Europe/Istanbul:${start}`, `DTEND;TZID=Europe/Istanbul:${end}`, "END:VEVENT"];

test("calendar: merges several calendars; shows the next event when today is done", async () => {
  const f = fakeFetch({
    "https://cal/a.ics": cal(event("1", "Standup", "20260929T093000", "20260929T094500")),
    "https://cal/b.ics": cal(event("2", "Dinner", "20261001T200000", "20261001T220000")),
  });
  const now = new Date(2026, 8, 29, 12, 0);
  const r = await S.calendar({ fetchFn: f, icsUrls: ["https://cal/a.ics", "https://cal/b.ics"], now });
  assert.deepEqual([...r.events.map((e) => e.summary)], ["Standup"]);
  assert.equal(r.next.summary, "Dinner");
  await assert.rejects(S.calendar({ fetchFn: f, icsUrls: [] }), (e) => e.code === "setup");
  await assert.rejects(S.calendar({ fetchFn: fakeFetch({ "https://x": "<html/>" }), icsUrls: ["https://x"] }), (e) => e.code === "parse");
});

const pr = (n, title, extra = {}) => ({ number: n, title, html_url: `https://github.com/a/b/pull/${n}`, repository_url: "https://api.github.com/repos/a/b", updated_at: "2026-09-29T08:00:00Z", ...extra });
function githubRoutes() {
  return (url) => {
    if (url.startsWith("https://api.github.com/notifications")) return [{ reason: "mention", updated_at: "2026-09-29T08:00:00Z", repository: { full_name: "a/b" }, subject: { title: "Bug", type: "Issue", url: "https://api.github.com/repos/a/b/issues/1" } }];
    const q = decodeURIComponent(url.split("q=")[1]);
    if (q.includes("review-requested:@me")) return { items: [pr(7, "Please review")] };
    if (q.includes("review:approved")) return { items: [pr(1, "Ready")] };
    if (q.includes("review:changes_requested")) return { items: [pr(2, "Needs work")] };
    if (q.includes("author:@me")) return { items: [pr(1, "Ready"), pr(2, "Needs work"), pr(3, "Fresh"), pr(4, "WIP", { draft: true })] };
    return undefined;
  };
}

test("github: notifications, review requests and my PRs with status", async () => {
  const f = fakeFetch(githubRoutes());
  const r = await S.github({ fetchFn: f, token: "ghp_x" });
  assert.equal(r.count, 1);
  assert.deepEqual([...r.reviews.map((p) => `${p.repo}#${p.number}`)], ["a/b#7"]);
  assert.deepEqual([...r.mine.map((p) => `${p.number}:${p.status}`)], ["1:approved", "2:changes requested", "3:waiting for review", "4:draft"]);
  assert.ok(f.calls.every((c) => c.init.headers.authorization === "Bearer ghp_x"));
  assert.equal(f.calls.length, 5);
});

test("github: setup and bad-token errors", async () => {
  await assert.rejects(S.github({ fetchFn: fakeFetch({}) }), (e) => e.code === "setup");
  await assert.rejects(S.github({ fetchFn: fakeFetch(() => ({ status: 401, body: {} })), token: "bad" }), (e) => e.code === "auth");
});

test("hacker news: top stories", async () => {
  const f = fakeFetch((url) => {
    if (url.endsWith("topstories.json")) return [11, 12, 13];
    const id = Number(url.match(/item\/(\d+)/)[1]);
    return { id, title: `Story ${id}`, url: `https://s/${id}`, score: id, descendants: 1 };
  });
  const r = await S.hn({ fetchFn: f, limit: 2 });
  assert.deepEqual([...r.items.map((i) => i.title)], ["Story 11", "Story 12"]);
});
