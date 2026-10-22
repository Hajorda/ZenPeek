import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "./load.js";

const ctx = loadGlobals(["core.uc.js", "strings.uc.js", "sources.uc.js", "cards.uc.js"], { Intl });
const Cards = ctx.ZPCards;
const Strings = ctx.ZPStrings;

test("each site gets the right card", () => {
  assert.deepEqual({ ...Cards.match("https://mail.google.com/mail/u/1/#inbox") }, { type: "gmail", account: 1 });
  assert.equal(Cards.match("https://mail.google.com/mail/").account, 0);
  assert.equal(Cards.match("https://calendar.google.com/calendar/r").type, "calendar");
  assert.equal(Cards.match("https://github.com/").type, "github");
  assert.equal(Cards.match("https://www.github.com/zen-browser").type, "github");
  assert.equal(Cards.match("https://news.ycombinator.com/").type, "hn");
  assert.equal(Cards.match("https://example.com/"), null);
  assert.equal(Cards.match("not a url"), null);
});

test("cache keys change with every setting that changes the data", () => {
  const s = { items: 5, githubReviews: true, githubMine: true, githubNotifications: true, githubCi: true };
  assert.notEqual(Cards.keyOf({ type: "gmail", account: 0 }, s), Cards.keyOf({ type: "gmail", account: 1 }, s));
  assert.notEqual(Cards.keyOf({ type: "gmail", account: 0 }, s), Cards.keyOf({ type: "gmail", account: 0 }, { ...s, items: 3 }));
  assert.notEqual(Cards.keyOf({ type: "github" }, s), Cards.keyOf({ type: "github" }, { ...s, githubCi: false }));
  assert.equal(Cards.keyOf({ type: "hn" }, s), "hn:5");
});

test("badge counts come from the card's data", () => {
  const s = { githubNotifications: true, githubReviews: true };
  assert.equal(Cards.get("gmail").count({ unread: 4, mails: [] }, s), 4);
  assert.equal(Cards.get("github").count({ count: 3, reviews: [{}, {}] }, s), 5);
  assert.equal(Cards.get("github").count({ count: 3, reviews: [{}, {}] }, { ...s, githubNotifications: false }), 2);
  assert.equal(Cards.get("calendar").count, undefined, "the calendar has no unread count");
});

test("a card without the required parts is refused", () => {
  assert.throws(() => Cards.register({ type: "x", match: () => null }), /missing "load"/);
});

test("every language has every text, with the same placeholders", () => {
  const { en, ...others } = Strings.tables;
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const [lang, table] of Object.entries(others)) {
    assert.deepEqual(Object.keys(table).sort(), Object.keys(en).sort(), `${lang} has the same keys as English`);
    for (const k of Object.keys(en)) assert.equal(holes(table[k]), holes(en[k]), `${lang} ${k}`);
  }
});

test("texts: language choice and placeholders", () => {
  assert.equal(Strings.use("tr-TR"), "tr");
  assert.equal(Strings.t("unread", { n: 3 }), "3 okunmamış");
  assert.equal(Strings.use("de-DE"), "en", "no German yet: English");
  assert.equal(Strings.t("unread", { n: 3 }), "3 unread");
  assert.equal(Strings.t("cal.soon"), "in {n} min", "a missing value stays visible rather than breaking");
  assert.equal(Strings.t("no.such.key"), "no.such.key");
});
