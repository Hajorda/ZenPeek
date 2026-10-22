import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "./load.js";

const C = loadGlobals(["core.uc.js"], { Intl }).ZPCore;
const iso = (d) => d.toISOString();

test("parses Gmail's Atom feed, entities included", () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://purl.org/atom/ns#" version="0.3">
  <title>Gmail - Inbox for me@gmail.com</title><fullcount>12</fullcount>
  <entry><title>Q4 plan &amp; budget</title><summary>Hi team, here&#39;s the plan</summary>
  <link rel="alternate" href="https://mail.google.com/mail/u/0?account_id=me@gmail.com&amp;message_id=1&amp;view=conv" type="text/html"/>
  <issued>2026-09-29T08:15:00Z</issued><author><name>Ayşe Yılmaz</name><email>ayse@example.com</email></author></entry>
  <entry><title></title><issued>2026-09-29T07:00:00Z</issued><author><email>bot@example.com</email></author></entry>
  </feed>`;
  const r = C.parseGmailAtom(xml);
  assert.equal(r.unread, 12);
  assert.equal(r.mails.length, 2);
  assert.equal(r.mails[0].subject, "Q4 plan & budget");
  assert.equal(r.mails[0].snippet, "Hi team, here's the plan");
  assert.equal(r.mails[0].from, "Ayşe Yılmaz");
  assert.equal(r.mails[0].url, "https://mail.google.com/mail/u/0?account_id=me@gmail.com&message_id=1&view=conv");
  assert.equal(iso(r.mails[0].date), "2026-09-29T08:15:00.000Z");
  assert.equal(r.mails[1].subject, "", "the card shows its own (translated) placeholder");
  assert.equal(r.mails[1].from, "bot@example.com");
  assert.throws(() => C.parseGmailAtom("<html>Sign in</html>"), /signed out/);
});

test("zoned converts wall-clock time in a zone, across DST", () => {
  assert.equal(iso(C.zoned(2026, 0, 15, 9, 0, 0, "America/New_York")), "2026-01-15T14:00:00.000Z");
  assert.equal(iso(C.zoned(2026, 6, 15, 9, 0, 0, "America/New_York")), "2026-07-15T13:00:00.000Z");
  assert.equal(iso(C.zoned(2026, 8, 29, 10, 0, 0, "Europe/Istanbul")), "2026-09-29T07:00:00.000Z");
});

const ics = (body, tz = "Europe/Istanbul") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:${tz}\r\n${body.trim().split("\n").map((l) => l.trim()).join("\r\n")}\r\nEND:VCALENDAR\r\n`;

test("today's events: single, all-day, UTC, TZID and floating times", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:a
    SUMMARY:Dentist\\, quick
    DTSTART;TZID=Europe/Istanbul:20260929T150000
    DTEND;TZID=Europe/Istanbul:20260929T153000
    LOCATION:Kadıköy
    END:VEVENT
    BEGIN:VEVENT
    UID:b
    SUMMARY:Holiday
    DTSTART;VALUE=DATE:20260929
    DTEND;VALUE=DATE:20260930
    END:VEVENT
    BEGIN:VEVENT
    UID:c
    SUMMARY:Call with NYC
    DTSTART:20260929T130000Z
    DURATION:PT45M
    END:VEVENT
    BEGIN:VEVENT
    UID:d
    SUMMARY:Tomorrow
    DTSTART;TZID=Europe/Istanbul:20260930T090000
    DTEND;TZID=Europe/Istanbul:20260930T100000
    END:VEVENT
    BEGIN:VEVENT
    UID:e
    SUMMARY:Cancelled thing
    STATUS:CANCELLED
    DTSTART;TZID=Europe/Istanbul:20260929T110000
    DTEND;TZID=Europe/Istanbul:20260929T120000
    END:VEVENT`);
  const today = C.eventsOnDay(C.parseICS(cal), new Date(2026, 8, 29, 12));
  assert.deepEqual([...today.map((e) => e.summary)], ["Holiday", "Dentist, quick", "Call with NYC"]);
  assert.equal(today[0].allDay, true);
  assert.equal(today[1].location, "Kadıköy");
  assert.equal(iso(today[2].end), "2026-09-29T13:45:00.000Z");
});

test("recurring events: weekly BYDAY, daily with EXDATE, COUNT, UNTIL and a moved instance", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:standup
    SUMMARY:Standup
    DTSTART;TZID=Europe/Istanbul:20260105T093000
    DTEND;TZID=Europe/Istanbul:20260105T094500
    RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
    END:VEVENT
    BEGIN:VEVENT
    UID:standup
    RECURRENCE-ID;TZID=Europe/Istanbul:20260929T093000
    SUMMARY:Standup (moved)
    DTSTART;TZID=Europe/Istanbul:20260929T110000
    DTEND;TZID=Europe/Istanbul:20260929T111500
    END:VEVENT
    BEGIN:VEVENT
    UID:gym
    SUMMARY:Gym
    DTSTART;TZID=Europe/Istanbul:20260901T190000
    DTEND;TZID=Europe/Istanbul:20260901T200000
    RRULE:FREQ=DAILY;INTERVAL=2
    EXDATE;TZID=Europe/Istanbul:20260929T190000
    END:VEVENT
    BEGIN:VEVENT
    UID:course
    SUMMARY:Course
    DTSTART;TZID=Europe/Istanbul:20260901T180000
    DTEND;TZID=Europe/Istanbul:20260901T190000
    RRULE:FREQ=WEEKLY;COUNT=3
    END:VEVENT
    BEGIN:VEVENT
    UID:1on1
    SUMMARY:1:1
    DTSTART;TZID=Europe/Istanbul:20260901T140000
    DTEND;TZID=Europe/Istanbul:20260901T143000
    RRULE:FREQ=WEEKLY;UNTIL=20261231T000000Z
    END:VEVENT
    BEGIN:VEVENT
    UID:rent
    SUMMARY:Pay rent
    DTSTART;VALUE=DATE:20260129
    RRULE:FREQ=MONTHLY
    END:VEVENT`);
  const events = C.parseICS(cal);
  const names = (d) => [...C.eventsOnDay(events, d).map((e) => e.summary)];
  // Tue 29 Sep 2026: standup moved to 11:00; gym skipped by EXDATE; course ended (COUNT=3); 1:1 every Tuesday.
  assert.deepEqual(names(new Date(2026, 8, 29)), ["Pay rent", "Standup (moved)", "1:1"]);
  // Gym is every 2 days from 1 Sep: 27 Sep yes, 29 Sep excluded (EXDATE), 30 Sep no, 1 Oct yes.
  assert.ok(names(new Date(2026, 8, 27)).includes("Gym"));
  assert.deepEqual(names(new Date(2026, 8, 30)), ["Standup"]);
  assert.ok(names(new Date(2026, 9, 1)).includes("Gym"));
  // Saturday: nothing on weekdays-only standup.
  assert.ok(!names(new Date(2026, 9, 3)).includes("Standup"));
  // After UNTIL: no 1:1.
  assert.ok(!names(new Date(2027, 0, 5)).includes("1:1"));
});

test("parseICS rejects things that aren't calendars", () => {
  assert.throws(() => C.parseICS("<html>login</html>"), /not an iCalendar/);
});

test("GitHub notifications become links to the right pages", () => {
  const items = C.parseGithubNotifications([
    { reason: "review_requested", updated_at: "2026-09-29T08:00:00Z", repository: { full_name: "zen-browser/desktop" }, subject: { title: "Fix folders", type: "PullRequest", url: "https://api.github.com/repos/zen-browser/desktop/pulls/9133" } },
    { reason: "mention", updated_at: "2026-09-29T07:00:00Z", repository: { full_name: "a/b" }, subject: { title: "Bug", type: "Issue", url: "https://api.github.com/repos/a/b/issues/7" } },
    { reason: "subscribed", updated_at: "2026-09-29T06:00:00Z", repository: { full_name: "a/b" }, subject: { title: "v2", type: "Release", url: null } },
  ]);
  assert.deepEqual([...items.map((i) => i.url)], ["https://github.com/zen-browser/desktop/pull/9133", "https://github.com/a/b/issues/7", "https://github.com/a/b"]);
  assert.throws(() => C.parseGithubNotifications({ message: "Bad credentials" }));
});

test("formatting helpers", () => {
  const now = new Date("2026-09-29T10:00:00Z");
  assert.equal(C.relTime(new Date("2026-09-29T09:15:00Z"), now, "en"), "45 min. ago");
  assert.equal(C.eventStatus({ start: new Date("2026-09-29T09:30:00Z"), end: new Date("2026-09-29T10:30:00Z") }, now).kind, "now");
  const soon = C.eventStatus({ start: new Date("2026-09-29T10:25:00Z"), end: new Date("2026-09-29T11:00:00Z") }, now);
  assert.equal(`${soon.kind} ${soon.minutes}`, "soon 25");
  assert.equal(C.eventStatus({ start: new Date("2026-09-29T15:00:00Z"), end: new Date("2026-09-29T16:00:00Z") }, now), null);
  const hn = C.parseHnItem({ id: 5, title: "Ask HN", score: 12, descendants: 3 });
  assert.equal(hn.url, "https://news.ycombinator.com/item?id=5");
});

test("cache expires entries", () => {
  let t = 0;
  const c = new C.Cache(1000, () => t);
  c.set("k", 1);
  assert.equal(c.get("k"), 1);
  t = 1500;
  assert.equal(c.get("k"), undefined);
  assert.equal(c.peek("k").fresh, false, "peek still returns it, marked old");
});

test("cache keeps only the most recently used entries, and older data never replaces newer", () => {
  let t = 0;
  const c = new C.Cache(1000, () => t, 3);
  for (const k of ["a", "b", "c"]) c.set(k, k);
  c.get("a"); // a is now the most recently used
  c.set("d", "d");
  assert.deepEqual([...c.map.keys()], ["c", "a", "d"], "b was the least recently used");
  assert.equal(c.setAt("a", "older", -5), false);
  assert.equal(c.peek("a").value, "a");
  assert.equal(c.setAt("a", "newer", 10), true);
  assert.equal(c.peek("a").value, "newer");
  t = 5000;
  c.set("e", "e");
  c.prune(1000);
  assert.deepEqual([...c.map.keys()], ["e"]);
});

test("dates survive storing as JSON", () => {
  const data = { events: [{ start: new Date("2026-09-29T10:00:00Z"), list: [new Date(0)] }], n: 2, s: "x", none: null };
  const back = C.fromStorable(JSON.parse(JSON.stringify(C.toStorable(data))));
  assert.equal(back.events[0].start.toISOString(), "2026-09-29T10:00:00.000Z");
  assert.equal(back.events[0].list[0].getTime(), 0);
  assert.equal(back.n, 2);
  assert.equal(back.none, null);
});

test("recurring events: monthly by weekday (2nd Tuesday, last Friday), BYSETPOS, yearly, daily on weekdays", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:patch
    SUMMARY:Patch Tuesday
    DTSTART;TZID=Europe/Istanbul:20260113T100000
    DTEND;TZID=Europe/Istanbul:20260113T110000
    RRULE:FREQ=MONTHLY;BYDAY=2TU
    END:VEVENT
    BEGIN:VEVENT
    UID:retro
    SUMMARY:Retro
    DTSTART;TZID=Europe/Istanbul:20260130T160000
    DTEND;TZID=Europe/Istanbul:20260130T170000
    RRULE:FREQ=MONTHLY;BYDAY=-1FR
    END:VEVENT
    BEGIN:VEVENT
    UID:lastworkday
    SUMMARY:Payroll
    DTSTART;TZID=Europe/Istanbul:20260130T090000
    DTEND;TZID=Europe/Istanbul:20260130T093000
    RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1
    END:VEVENT
    BEGIN:VEVENT
    UID:thanks
    SUMMARY:Thanksgiving
    DTSTART;VALUE=DATE:20251127
    RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH
    END:VEVENT
    BEGIN:VEVENT
    UID:walk
    SUMMARY:Walk
    DTSTART;TZID=Europe/Istanbul:20260901T070000
    DTEND;TZID=Europe/Istanbul:20260901T073000
    RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR
    END:VEVENT
    BEGIN:VEVENT
    UID:third
    SUMMARY:Book club
    DTSTART;TZID=Europe/Istanbul:20260101T190000
    DTEND;TZID=Europe/Istanbul:20260101T200000
    RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=20
    END:VEVENT`);
  const events = C.parseICS(cal);
  const names = (d) => [...C.eventsOnDay(events, d).map((e) => e.summary)];
  // October 2026: 2nd Tuesday = 13th, last Friday = 30th (also the last weekday).
  assert.ok(names(new Date(2026, 9, 13)).includes("Patch Tuesday"));
  assert.ok(!names(new Date(2026, 9, 6)).includes("Patch Tuesday"), "1st Tuesday is not the 2nd");
  assert.ok(!names(new Date(2026, 9, 20)).includes("Patch Tuesday"));
  assert.ok(names(new Date(2026, 9, 30)).includes("Retro"));
  assert.ok(!names(new Date(2026, 9, 23)).includes("Retro"));
  assert.ok(names(new Date(2026, 9, 30)).includes("Payroll"));
  // May 2026 ends on Sunday 31st: the last weekday is Friday 29th.
  assert.ok(names(new Date(2026, 4, 29)).includes("Payroll"));
  assert.ok(!names(new Date(2026, 4, 31)).includes("Payroll"));
  // 4th Thursday of November 2026 is the 26th.
  assert.ok(names(new Date(2026, 10, 26)).includes("Thanksgiving"));
  assert.ok(!names(new Date(2026, 10, 19)).includes("Thanksgiving"));
  // Daily on weekdays: not on Saturday 3 Oct 2026.
  assert.ok(names(new Date(2026, 9, 2)).includes("Walk"));
  assert.ok(!names(new Date(2026, 9, 3)).includes("Walk"));
  // BYMONTHDAY=-1: last day of each month (30 Sep, 28 Feb).
  assert.ok(names(new Date(2026, 8, 30)).includes("Book club"));
  assert.ok(names(new Date(2026, 1, 28)).includes("Book club"));
  assert.ok(!names(new Date(2026, 8, 29)).includes("Book club"));
});

test("meeting links are found in the conference data, location or description", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:m1
    SUMMARY:Sync
    DTSTART;TZID=Europe/Istanbul:20260929T100000
    DTEND;TZID=Europe/Istanbul:20260929T103000
    X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
    END:VEVENT
    BEGIN:VEVENT
    UID:m2
    SUMMARY:Customer call
    DTSTART;TZID=Europe/Istanbul:20260929T110000
    DTEND;TZID=Europe/Istanbul:20260929T113000
    DESCRIPTION:Join Zoom Meeting\\nhttps://us02web.zoom.us/j/123456789?pwd=abc.\\nMeeting ID: 123
    END:VEVENT
    BEGIN:VEVENT
    UID:m3
    SUMMARY:Lunch
    DTSTART;TZID=Europe/Istanbul:20260929T120000
    DTEND;TZID=Europe/Istanbul:20260929T130000
    LOCATION:Kadıköy
    END:VEVENT`);
  const today = C.eventsOnDay(C.parseICS(cal), new Date(2026, 8, 29));
  assert.deepEqual({ ...today[0].meeting }, { url: "https://meet.google.com/abc-defg-hij", provider: "Google Meet" });
  assert.deepEqual({ ...today[1].meeting }, { url: "https://us02web.zoom.us/j/123456789?pwd=abc", provider: "Zoom" });
  assert.equal(today[2].meeting, null);
  assert.equal(C.meetingLink({ location: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x" }).provider, "Teams");

  const now = new Date("2026-09-29T10:00:00Z");
  const ev = (startMin) => ({ meeting: { url: "x" }, start: new Date(now.getTime() + startMin * 60000), end: new Date(now.getTime() + (startMin + 30) * 60000) });
  assert.equal(C.joinable(ev(5), now, "soon"), true);
  assert.equal(C.joinable(ev(-10), now, "soon"), true, "still running");
  assert.equal(C.joinable(ev(30), now, "soon"), false, "too early");
  assert.equal(C.joinable(ev(30), now, "always"), true);
  assert.equal(C.joinable(ev(-60), now, "always"), false, "already over");
  assert.equal(C.joinable(ev(5), now, "off"), false);
});

test("unread counts in tab titles", () => {
  const b = (title) => {
    const r = C.parseTitleBadge(title);
    return r && `${r.count ?? "-"}${r.dot ? " dot" : ""}${r.more ? "+" : ""}`;
  };
  assert.equal(b("(3) WhatsApp"), "3");
  assert.equal(b("[12] Discord | #general"), "12");
  assert.equal(b("(99+) Messenger"), "99+");
  assert.equal(b("Inbox (7) - me@gmail.com - Gmail"), "7");
  assert.equal(b("Gelen Kutusu (2) - me@gmail.com - Gmail"), "2");
  assert.equal(b("• Discord | Friends"), "- dot");
  assert.equal(b("* Slack | general | Team"), "- dot");
  assert.equal(b("Slack | general | Team"), null);
  assert.equal(b("(2024) Best films of the year"), null, "a year, not a count");
  assert.equal(b("(0) WhatsApp"), null);
  assert.equal(b("Movie Night (2)"), null, "a count must be at the start, or before a separator");
  assert.equal(b(""), null);

  assert.equal(C.badgeText(3), "3");
  assert.equal(C.badgeText(250), "99+");
  assert.equal(C.badgeText(3, { style: "dot" }), "");
  assert.equal(C.badgeText(0, { dot: true }), "");
  assert.equal(C.badgeText(0), null);
  assert.equal(C.badgeText(3, { style: "off" }), null);
});

test("the pointer counts as heading for the preview inside the safe triangle", () => {
  const panel = { left: 220, right: 540, top: 40, bottom: 300 };
  const origin = { x: 100, y: 60 };
  assert.equal(C.headingToward(origin, { x: 160, y: 90 }, panel), true, "diagonally toward the card");
  assert.equal(C.headingToward(origin, { x: 100, y: 200 }, panel), false, "straight down the sidebar");
  assert.equal(C.headingToward(origin, { x: 40, y: 60 }, panel), false, "away from the card");
  assert.equal(C.headingToward(origin, { x: 300, y: 100 }, panel), true, "already over the card");
  // Card on the left (sidebar on the right).
  assert.equal(C.headingToward({ x: 800, y: 60 }, { x: 740, y: 90 }, { left: 360, right: 680, top: 40, bottom: 300 }), true);
});

test("GitHub GraphQL pull requests: review decision and CI state", () => {
  const pr = (n, extra = {}) => ({ title: `PR ${n}`, number: n, url: `https://github.com/a/b/pull/${n}`, isDraft: false, updatedAt: "2026-09-29T08:00:00Z", repository: { nameWithOwner: "a/b" }, ...extra });
  const ci = (state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } });
  const r = C.parseGithubGraphql({ data: {
    reviews: { nodes: [pr(7), {}] },
    mine: { nodes: [
      pr(1, { reviewDecision: "APPROVED", ...ci("SUCCESS") }),
      pr(2, { reviewDecision: "CHANGES_REQUESTED", ...ci("FAILURE") }),
      pr(3, { reviewDecision: "REVIEW_REQUIRED", ...ci("PENDING") }),
      pr(4, { isDraft: true, ...ci(null) }),
    ] },
  } });
  assert.deepEqual([...r.reviews.map((p) => `${p.repo}#${p.number}`)], ["a/b#7"], "non-PR results are skipped");
  assert.deepEqual([...r.mine.map((p) => `${p.number}:${p.status}:${p.ci}`)], ["1:approved:passing", "2:changes requested:failing", "3:waiting for review:running", "4:draft:"]);
  assert.deepEqual([...C.parseGithubGraphql({ data: { mine: { nodes: [] } } }).reviews], [], "a section that wasn't asked for is empty");
  assert.throws(() => C.parseGithubGraphql({ errors: [{ message: "Bad query" }] }), /Bad query/);
});

test("weather and the day timeline", () => {
  const now = new Date("2026-10-22T11:20:00Z");
  const json = {
    utc_offset_seconds: 10800,
    current: { temperature_2m: 18.4, apparent_temperature: 17.2, weather_code: 61, wind_speed_10m: 12.6, is_day: 1 },
    hourly: { time: ["2026-10-22T13:00", "2026-10-22T14:00", "2026-10-22T15:00", "2026-10-22T16:00"], temperature_2m: [17, 18, 19, 18], weather_code: [3, 61, 0, 0], precipitation_probability: [10, 70, 0, 0] },
    daily: { temperature_2m_max: [21.2], temperature_2m_min: [12.8] },
  };
  const w = C.parseWeather(json, { now, hours: 3 });
  assert.equal(w.current.temp, 18);
  assert.deepEqual({ ...w.today }, { max: 21, min: 13 });
  assert.equal(w.hours[0].time.toISOString(), "2026-10-22T11:00:00.000Z", "the 14:00 local hour, still running");
  assert.equal(w.hours.length, 3);
  assert.equal(C.weatherKind(61).key, "rain");
  assert.equal(C.weatherKind(0, false).icon, "🌙");

  const day = new Date(2026, 9, 22);
  const ev = (h1, h2) => ({ start: new Date(2026, 9, 22, h1), end: new Date(2026, 9, 22, h2), allDay: false });
  const range = C.timelineRange([ev(7, 8), ev(21, 22)], day, new Date(2026, 9, 22, 12));
  assert.equal(new Date(range.from).getHours(), 7);
  assert.equal(new Date(range.to).getHours(), 22);
});
