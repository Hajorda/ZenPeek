// @ts-check
// Zen Peek — fetches the data behind each card. `fetchFn` is injected so the
// tests can run without a network. Errors carry a `code` the UI explains.
/* exported ZPSources */
// eslint-disable-next-line no-var
var ZPSources = (() => {
  "use strict";
  const Core = ZPCore;

  // Codes: setup | signed-out | auth | network | timeout | rate-limited | server | parse | aborted.
  // "rate-limited" errors also carry `retryAt` (ms since epoch).
  class SourceError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.code = code;
      /** @type {number | undefined} */
      this.retryAt = extra.retryAt;
    }
  }

  const abortedError = () => new SourceError("aborted", "Cancelled");
  const DEFAULT_TIMEOUT_MS = 10_000;

  // When a rate-limited service says we may try again (ms since epoch), or null.
  // Reads Retry-After (seconds or a date) and GitHub's x-ratelimit-* headers.
  function retryAt(headers, now = Date.now()) {
    const get = (k) => {
      try {
        return headers?.get?.(k) ?? null;
      } catch {
        return null;
      }
    };
    const after = get("retry-after");
    if (after !== null && after !== "") {
      const secs = Number(after);
      if (Number.isFinite(secs)) return now + Math.max(1, secs) * 1000;
      const date = Date.parse(after);
      if (!Number.isNaN(date)) return Math.max(now + 1000, date);
    }
    const reset = Number(get("x-ratelimit-reset"));
    if (get("x-ratelimit-remaining") === "0" && reset > 0) return Math.max(now + 1000, reset * 1000);
    return null;
  }

  // One request, with the caller's cancel `signal` plus a timeout, and every
  // failure turned into a SourceError. Returns the body as text or JSON.
  async function request(fetchFn, url, { init = {}, signal = undefined, timeoutMs = DEFAULT_TIMEOUT_MS, as = "text", now = Date.now } = {}) {
    if (signal?.aborted) throw abortedError();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const failure = (e, code = "network") => {
      if (signal?.aborted) return abortedError();
      if (timedOut) return new SourceError("timeout", `No answer after ${Math.round(timeoutMs / 1000)} s`);
      if (e instanceof SourceError) return e;
      return new SourceError(code, String(e?.message || e));
    };
    try {
      let res;
      try {
        res = await fetchFn(url, { cache: "no-store", ...init, signal: controller.signal });
      } catch (e) {
        throw failure(e);
      }
      const retry = retryAt(res.headers, now());
      if (res.status === 429 || (res.status === 403 && retry)) {
        throw new SourceError("rate-limited", `HTTP ${res.status}`, { retryAt: retry ?? now() + 60_000 });
      }
      if (res.status === 401 || res.status === 403) throw new SourceError("auth", `HTTP ${res.status}`);
      if (!res.ok) throw new SourceError("server", `HTTP ${res.status}`);
      try {
        return as === "json" ? await res.json() : await res.text();
      } catch (e) {
        throw failure(e, as === "json" ? "parse" : "network");
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // Gmail: the unread Atom feed, using the browser's own Google login.
  async function gmail({ fetchFn, account = 0, limit = 5, signal = undefined, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const text = await request(fetchFn, `https://mail.google.com/mail/u/${account}/feed/atom`, { init: { credentials: "include" }, signal, timeoutMs });
    let data;
    try {
      data = Core.parseGmailAtom(text);
    } catch {
      throw new SourceError("signed-out", "Not signed in to Gmail in this browser");
    }
    return { unread: data.unread, mails: data.mails.slice(0, limit) };
  }

  // Calendars by iCal address (Google: Settings → your calendar → "Secret address
  // in iCal format"). Today's events, plus the next one if today is done.
  async function calendar({ fetchFn, icsUrls = [], now = new Date(), limit = 8, signal = undefined, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!icsUrls.length) throw new SourceError("setup", "Add your calendar's secret iCal address in Zen Peek's settings");
    const texts = await Promise.all(icsUrls.map((url) => request(fetchFn, url, { signal, timeoutMs })));
    const all = [];
    for (const text of texts) {
      try {
        all.push(...Core.parseICS(text));
      } catch {
        throw new SourceError("parse", "That address didn't return a calendar");
      }
    }
    const today = Core.eventsOnDay(all, now).slice(0, limit); // past ones are shown dimmed
    let next = null;
    if (!today.some((e) => !e.allDay && e.end > now)) {
      for (let i = 1; i <= 14 && !next; i++) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        next = Core.eventsOnDay(all, day).find((e) => !e.allDay) || null;
      }
    }
    return { events: today, next };
  }

  // GitHub pull requests in one GraphQL request: review requests, and my open
  // PRs with their review decision and CI state.
  const PR_FIELDS = "title number url isDraft updatedAt repository { nameWithOwner }";
  const GRAPHQL = `query ZenPeek($reviewQ: String!, $mineQ: String!, $n: Int!, $reviews: Boolean!, $mine: Boolean!, $ci: Boolean!) {
  reviews: search(query: $reviewQ, type: ISSUE, first: $n) @include(if: $reviews) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  mine: search(query: $mineQ, type: ISSUE, first: $n) @include(if: $mine) { nodes { ... on PullRequest { ${PR_FIELDS} reviewDecision
    commits(last: 1) @include(if: $ci) { nodes { commit { statusCheckRollup { state } } } } } } }
}`;
  const OPEN_PRS = "is:open is:pr archived:false";

  // GitHub: notifications (REST) and pull requests (GraphQL; the older REST
  // searches are the fallback if GraphQL fails). Needs a personal access token.
  async function github({ fetchFn, token, limit = 5, signal = undefined, timeoutMs = DEFAULT_TIMEOUT_MS, sections = {} }) {
    if (!token) throw new SourceError("setup", "Set a GitHub token (right-click a GitHub Essential → Zen Peek: set GitHub token…)");
    const want = { reviews: true, mine: true, notifications: true, ci: true, ...sections };
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    const api = (path) => request(fetchFn, `https://api.github.com${path}`, { init: { headers }, signal, timeoutMs, as: "json" });

    const viaGraphql = async () => {
      const json = await request(fetchFn, "https://api.github.com/graphql", {
        init: {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            query: GRAPHQL,
            variables: {
              reviewQ: `${OPEN_PRS} review-requested:@me sort:updated-desc`,
              mineQ: `${OPEN_PRS} author:@me sort:updated-desc`,
              n: Math.min(20, limit),
              reviews: !!want.reviews,
              mine: !!want.mine,
              ci: !!want.ci,
            },
          }),
        },
        signal, timeoutMs, as: "json",
      });
      try {
        return Core.parseGithubGraphql(json);
      } catch (e) {
        throw new SourceError("parse", String(e?.message || e));
      }
    };
    const viaRest = async () => {
      const search = (q) => api(`/search/issues?per_page=10&sort=updated&q=${encodeURIComponent(q)}`).then(Core.parseGithubSearch);
      const none = Promise.resolve([]);
      const [reviews, mine, approved, changes] = await Promise.all([
        want.reviews ? search(`${OPEN_PRS} review-requested:@me`) : none,
        want.mine ? search(`${OPEN_PRS} author:@me`) : none,
        want.mine ? search(`${OPEN_PRS} author:@me review:approved`) : none,
        want.mine ? search(`${OPEN_PRS} author:@me review:changes_requested`) : none,
      ]);
      const ok = new Set(approved.map((p) => p.url));
      const redo = new Set(changes.map((p) => p.url));
      const status = (p) => (p.draft ? "draft" : redo.has(p.url) ? "changes requested" : ok.has(p.url) ? "approved" : "waiting for review");
      return { reviews, mine: mine.map((p) => ({ ...p, status: status(p), ci: "" })) };
    };

    const [notes, prs] = await Promise.all([
      want.notifications ? api("/notifications?per_page=20").then(Core.parseGithubNotifications) : Promise.resolve([]),
      want.reviews || want.mine
        ? viaGraphql().catch((e) => {
          // Only fall back for problems with GraphQL itself, not for a bad token,
          // a rate limit, a timeout or a cancel.
          if (e?.code === "server" || e?.code === "parse") return viaRest();
          throw e;
        })
        : Promise.resolve({ reviews: [], mine: [] }),
    ]);
    return {
      count: notes.length,
      items: notes.slice(0, limit),
      reviews: prs.reviews.slice(0, limit),
      mine: prs.mine.slice(0, limit),
    };
  }

  // Hacker News: public API, top stories. Stories are cached for a few minutes
  // (in `itemCache`, kept by the caller), so a refresh usually costs one request.
  const HN_ITEM_TTL_MS = 5 * 60_000;
  async function hn({ fetchFn, limit = 5, signal = undefined, timeoutMs = DEFAULT_TIMEOUT_MS, itemCache = new Map(), now = Date.now }) {
    const base = "https://hacker-news.firebaseio.com/v0";
    const ids = await request(fetchFn, `${base}/topstories.json`, { signal, timeoutMs, as: "json" });
    if (!Array.isArray(ids)) throw new SourceError("parse", "unexpected Hacker News response");
    const top = ids.slice(0, limit);
    const items = await Promise.all(top.map(async (id) => {
      const hit = itemCache.get(id);
      if (hit && now() - hit.at < HN_ITEM_TTL_MS) return hit.item;
      const item = Core.parseHnItem(await request(fetchFn, `${base}/item/${id}.json`, { signal, timeoutMs, as: "json" }));
      itemCache.set(id, { item, at: now() });
      return item;
    }));
    for (const id of itemCache.keys()) if (!top.includes(id)) itemCache.delete(id); // keep it small
    return { items };
  }

  return { SourceError, request, retryAt, gmail, calendar, github, hn, DEFAULT_TIMEOUT_MS };
})();
