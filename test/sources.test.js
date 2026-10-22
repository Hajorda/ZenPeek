import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "./load.js";

const ctx = loadGlobals(["core.uc.js", "sources.uc.js"], { Intl });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = ctx.ZPSources;

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = typeof routes === "function" ? routes(url) : routes[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    const body = r.body ?? r;
    const headers = new Map(Object.entries(r.headers || {}));
    return {
      ok: (r.status || 200) < 400, status: r.status || 200, headers: { get: (k) => headers.get(k) ?? null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body,
    };
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
const gqlPr = (n, title, extra = {}) => ({ title, number: n, url: `https://github.com/a/b/pull/${n}`, isDraft: false, updatedAt: "2026-09-29T08:00:00Z", repository: { nameWithOwner: "a/b" }, ...extra });
const ciState = (state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } });
function githubRoutes({ graphql = "ok" } = {}) {
  return (url) => {
    if (url === "https://api.github.com/graphql") {
      if (graphql === "broken") return { status: 502, body: {} };
      return { data: {
        reviews: { nodes: [gqlPr(7, "Please review")] },
        mine: { nodes: [
          gqlPr(1, "Ready", { reviewDecision: "APPROVED", ...ciState("SUCCESS") }),
          gqlPr(2, "Needs work", { reviewDecision: "CHANGES_REQUESTED", ...ciState("FAILURE") }),
          gqlPr(3, "Fresh", { reviewDecision: "REVIEW_REQUIRED", ...ciState("PENDING") }),
          gqlPr(4, "WIP", { isDraft: true }),
        ] },
      } };
    }
    if (url.startsWith("https://api.github.com/notifications")) return [{ reason: "mention", updated_at: "2026-09-29T08:00:00Z", repository: { full_name: "a/b" }, subject: { title: "Bug", type: "Issue", url: "https://api.github.com/repos/a/b/issues/1" } }];
    const q = decodeURIComponent(url.split("q=")[1]);
    if (q.includes("review-requested:@me")) return { items: [pr(7, "Please review")] };
    if (q.includes("review:approved")) return { items: [pr(1, "Ready")] };
    if (q.includes("review:changes_requested")) return { items: [pr(2, "Needs work")] };
    if (q.includes("author:@me")) return { items: [pr(1, "Ready"), pr(2, "Needs work"), pr(3, "Fresh"), pr(4, "WIP", { draft: true })] };
    return undefined;
  };
}

test("github: notifications plus one GraphQL request for review requests and my PRs with status and CI", async () => {
  const f = fakeFetch(githubRoutes());
  const r = await S.github({ fetchFn: f, token: "ghp_x" });
  assert.equal(r.count, 1);
  assert.deepEqual([...r.reviews.map((p) => `${p.repo}#${p.number}`)], ["a/b#7"]);
  assert.deepEqual([...r.mine.map((p) => `${p.number}:${p.status}:${p.ci}`)], ["1:approved:passing", "2:changes requested:failing", "3:waiting for review:running", "4:draft:"]);
  assert.ok(f.calls.every((c) => c.init.headers.authorization === "Bearer ghp_x"));
  assert.equal(f.calls.length, 2, "notifications + one GraphQL query (was 5 requests)");
  const gql = f.calls.find((c) => c.url.endsWith("/graphql"));
  assert.equal(gql.init.method, "POST");
  const { variables } = JSON.parse(gql.init.body);
  assert.match(variables.reviewQ, /review-requested:@me/);
  assert.equal(variables.ci, true);
});

test("github: falls back to the REST searches if GraphQL fails", async () => {
  const f = fakeFetch(githubRoutes({ graphql: "broken" }));
  const r = await S.github({ fetchFn: f, token: "ghp_x" });
  assert.deepEqual([...r.mine.map((p) => `${p.number}:${p.status}`)], ["1:approved", "2:changes requested", "3:waiting for review", "4:draft"]);
  assert.equal(f.calls.length, 6, "notifications + failed GraphQL + 4 searches");
});

test("github: sections that are turned off aren't requested", async () => {
  const f = fakeFetch(githubRoutes());
  const r = await S.github({ fetchFn: f, token: "t", sections: { reviews: false, mine: false } });
  assert.equal(f.calls.length, 1);
  assert.equal(r.mine.length, 0);
  const g = fakeFetch(githubRoutes());
  await S.github({ fetchFn: g, token: "t", sections: { notifications: false, ci: false } });
  assert.equal(g.calls.length, 1);
  assert.equal(JSON.parse(g.calls[0].init.body).variables.ci, false);
});

test("rate limits: 429 and GitHub's 403 with no requests left become 'rate-limited' with a retry time", async () => {
  const now = Date.UTC(2026, 8, 29, 10, 0, 0);
  const at = (headers, status = 429) => S.request(fakeFetch(() => ({ status, headers, body: "" })), "https://x", { now: () => now });
  await assert.rejects(at({ "retry-after": "120" }), (e) => e.code === "rate-limited" && e.retryAt === now + 120_000);
  await assert.rejects(at({ "retry-after": "Tue, 29 Sep 2026 10:05:00 GMT" }), (e) => e.code === "rate-limited" && e.retryAt === now + 300_000);
  await assert.rejects(at({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 600) }, 403), (e) => e.code === "rate-limited" && e.retryAt === now + 600_000);
  await assert.rejects(at({}), (e) => e.code === "rate-limited" && e.retryAt === now + 60_000, "429 without a time: one minute");
  await assert.rejects(at({ "x-ratelimit-remaining": "4999" }, 403), (e) => e.code === "auth", "a plain 403 is still a refused token");
});

test("a service that doesn't answer times out", async () => {
  const never = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))));
  const started = Date.now();
  await assert.rejects(S.gmail({ fetchFn: never, timeoutMs: 40 }), (e) => e.code === "timeout");
  assert.ok(Date.now() - started < 1000);
  // A timeout while reading the body counts too.
  const slowBody = async (url, init) => ({ ok: true, status: 200, text: () => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("body aborted")))) });
  await assert.rejects(S.gmail({ fetchFn: slowBody, timeoutMs: 40 }), (e) => e.code === "timeout");
});

test("github: setup and bad-token errors", async () => {
  await assert.rejects(S.github({ fetchFn: fakeFetch({}) }), (e) => e.code === "setup");
  await assert.rejects(S.github({ fetchFn: fakeFetch(() => ({ status: 401, body: {} })), token: "bad" }), (e) => e.code === "auth");
});

test("hacker news: top stories; stories are reused for a few minutes", async () => {
  let top = [11, 12, 13];
  const f = fakeFetch((url) => {
    if (url.endsWith("topstories.json")) return top;
    const id = Number(url.match(/item\/(\d+)/)[1]);
    return { id, title: `Story ${id}`, url: `https://s/${id}`, score: id, descendants: 1 };
  });
  const itemCache = new Map();
  const r = await S.hn({ fetchFn: f, limit: 2, itemCache });
  assert.deepEqual([...r.items.map((i) => i.title)], ["Story 11", "Story 12"]);
  assert.equal(f.calls.length, 3);
  top = [12, 14, 11];
  const r2 = await S.hn({ fetchFn: f, limit: 2, itemCache });
  assert.deepEqual([...r2.items.map((i) => i.title)], ["Story 12", "Story 14"]);
  assert.equal(f.calls.length, 5, "only the list and the one new story");
  assert.deepEqual([...itemCache.keys()].sort(), [12, 14], "stories no longer on top are dropped");
});

test("every source forwards the cancel signal, and a cancel is reported as 'aborted'", async () => {
  const hanging = () => {
    const seen = [];
    const fn = (url, init) => {
      seen.push(init?.signal);
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))));
    };
    fn.seen = seen;
    return fn;
  };
  const cases = [
    (fetchFn, signal) => S.gmail({ fetchFn, signal }),
    (fetchFn, signal) => S.calendar({ fetchFn, icsUrls: ["https://cal/a.ics"], signal }),
    (fetchFn, signal) => S.github({ fetchFn, token: "t", signal }),
    (fetchFn, signal) => S.hn({ fetchFn, signal }),
  ];
  for (const run of cases) {
    const fetchFn = hanging();
    const c = new AbortController();
    const p = run(fetchFn, c.signal);
    await sleep(5);
    assert.ok(fetchFn.seen.length > 0 && fetchFn.seen.every((sig) => sig && !sig.aborted), "a signal is passed to fetch");
    c.abort();
    await assert.rejects(p, (e) => e.code === "aborted");
    assert.ok(fetchFn.seen.every((sig) => sig.aborted), "cancelling aborts every request");
  }
  // Already cancelled: no request at all.
  const fetchFn = hanging();
  const c = new AbortController();
  c.abort();
  await assert.rejects(S.gmail({ fetchFn, signal: c.signal }), (e) => e.code === "aborted");
  assert.equal(fetchFn.seen.length, 0);
});
