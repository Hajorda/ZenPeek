import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "./load.js";

const C = loadGlobals(["core.uc.js"], { Intl }).ZPCore;
const iso = (d) => d.toISOString();

test("cardFor picks the right card", () => {
  assert.deepEqual({ ...C.cardFor("https://mail.google.com/mail/u/1/#inbox") }, { type: "gmail", account: 1 });
  assert.equal(C.cardFor("https://mail.google.com/mail/").account, 0);
  assert.equal(C.cardFor("https://calendar.google.com/calendar/r").type, "calendar");
  assert.equal(C.cardFor("https://github.com/").type, "github");
  assert.equal(C.cardFor("https://news.ycombinator.com/").type, "hn");
  assert.equal(C.cardFor("https://example.com/"), null);
  assert.equal(C.cardFor("not a url"), null);
});

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
  assert.equal(r.mails[1].subject, "(no subject)");
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
  assert.equal(C.eventStatus({ start: new Date("2026-09-29T09:30:00Z"), end: new Date("2026-09-29T10:30:00Z") }, now), "now");
  assert.equal(C.eventStatus({ start: new Date("2026-09-29T10:25:00Z"), end: new Date("2026-09-29T11:00:00Z") }, now), "in 25 min");
  assert.equal(C.eventStatus({ start: new Date("2026-09-29T15:00:00Z"), end: new Date("2026-09-29T16:00:00Z") }, now), "");
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
});
