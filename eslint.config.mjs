import js from "@eslint/js";
import globals from "globals";

// The mod's files are classic scripts that Sine loads into Zen's browser window,
// in this order: core, strings, sources, zen-adapter, cards, peek.
const zenChrome = {
  Services: "readonly", ChromeUtils: "readonly", Components: "readonly", Ci: "readonly",
  IOUtils: "readonly", PathUtils: "readonly",
  gBrowser: "readonly", gZenWorkspaces: "readonly", gZenVerticalTabsManager: "readonly",
  TabContextMenu: "readonly", openTrustedLinkIn: "readonly",
};
const ours = { ZPCore: "readonly", ZPStrings: "readonly", ZPSources: "readonly", ZPZen: "readonly", ZPCards: "readonly" };

export default [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    files: ["mod/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: { ...globals.browser, ...zenChrome, ...ours },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      // Each file defines exactly one of these globals.
      "no-redeclare": ["error", { builtinGlobals: false }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    files: ["test/**/*.js", "scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: { "no-unused-vars": ["error", { args: "none" }] },
  },
];
