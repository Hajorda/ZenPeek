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

test("github: token header, setup and bad-token errors", async () => {
  const f = fakeFetch({ "https://api.github.com/notifications?per_page=20": [{ reason: "mention", updated_at: "2026-09-29T08:00:00Z", repository: { full_name: "a/b" }, subject: { title: "Bug", type: "Issue", url: "https://api.github.com/repos/a/b/issues/1" } }] });
  const r = await S.github({ fetchFn: f, token: "ghp_x" });
  assert.equal(r.count, 1);
  assert.equal(f.calls[0].init.headers.authorization, "Bearer ghp_x");
  await assert.rejects(S.github({ fetchFn: f }), (e) => e.code === "setup");
  await assert.rejects(S.github({ fetchFn: fakeFetch({ "https://api.github.com/notifications?per_page=20": { status: 401, body: {} } }), token: "bad" }), (e) => e.code === "auth");
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
