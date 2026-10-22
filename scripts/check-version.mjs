// Fails if the version numbers disagree: theme.json (what Sine shows),
// package.json, the README badge, the newest CHANGELOG entry and, when CI
// runs for a tag, the tag itself (v1.2.3).
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const versions = {
  "theme.json": JSON.parse(read("theme.json")).version,
  "package.json": JSON.parse(read("package.json")).version,
  "README badge": read("README.md").match(/badge\/version-([\d.]+)-/)?.[1],
  "CHANGELOG": read("CHANGELOG.md").match(/^## \[?v?([\d.]+)\]?/m)?.[1],
};
if (process.env.GITHUB_REF_TYPE === "tag") versions["git tag"] = process.env.GITHUB_REF_NAME?.replace(/^v/, "");

const expected = versions["theme.json"];
const wrong = Object.entries(versions).filter(([, v]) => v !== expected);
if (wrong.length) {
  console.error(`Version mismatch (theme.json says ${expected}):`);
  for (const [where, v] of wrong) console.error(`  ${where}: ${v ?? "missing"}`);
  process.exit(1);
}
console.log(`Version ${expected} everywhere.`);
