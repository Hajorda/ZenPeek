// Loads mod scripts the way Sine does (classic scripts in one global) and
// copies results out of the vm realm so deepStrictEqual works on them.
import { readFileSync } from "node:fs";
import vm from "node:vm";

export const read = (f) => readFileSync(new URL(`../mod/${f}`, import.meta.url), "utf8");

export function loadGlobals(files, globals = {}) {
  const ctx = vm.createContext({ URL, URLSearchParams, AbortController, setTimeout, clearTimeout, console, ...globals });
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}

const plain = (v) => (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);

// Wraps an object of functions so every result is a plain copy.
export const unwrap = (obj) =>
  new Proxy(obj, {
    get: (t, k) => (typeof t[k] === "function" ? (...a) => {
      const r = t[k](...a);
      return r instanceof Promise || (r && typeof r.then === "function") ? r.then(plain) : plain(r);
    } : plain(t[k])),
  });
