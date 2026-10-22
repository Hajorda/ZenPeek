// The real Zen adapter must offer everything the mod calls on it, so the fake
// adapter in peek-sim.test.js can't drift away from what runs in Zen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { read, loadGlobals } from "./load.js";

const Zen = loadGlobals(["zen-adapter.uc.js"]).ZPZen;
const has = (name) => name in Zen;

const used = (file) => new Set([...read(file).matchAll(/\bZen\.(\w+)/g)].map((m) => m[1]));

test("the real adapter has every member peek.uc.js and cards.uc.js use", () => {
  for (const file of ["peek.uc.js", "cards.uc.js"]) {
    for (const name of used(file)) assert.ok(has(name), `${file} uses Zen.${name}, which zen-adapter.uc.js doesn't have`);
  }
});

test("the fake adapter in the simulation covers the same members", () => {
  const sim = read("../test/peek-sim.test.js");
  const fakeBlock = sim.slice(sim.indexOf("const Zen = {"), sim.indexOf("const logins ="));
  for (const name of used("peek.uc.js")) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(fakeBlock), `the fake adapter is missing ${name}`);
  }
});

test("every Zen internal the adapter touches is listed at the top of the file", () => {
  const src = read("zen-adapter.uc.js");
  const header = src.slice(0, src.indexOf("var ZPZen"));
  for (const name of ["gZenWorkspaces", "gZenVerticalTabsManager", "TabContextMenu", "openTrustedLinkIn", "TabAddedToEssentials", "drawSnapshot", "Services.focus"]) {
    assert.ok(src.includes(name.split(".").pop()), `${name} used`);
    assert.ok(header.includes(name), `${name} is documented in the header`);
  }
});
