import globals from "globals";

const legacyGlobals = {
  // provided by dist/globals.js (src/entry/legacy-globals.js)
  ZSParse: "readonly", ZS: "readonly", ZSDomain: "readonly", ZSApp: "readonly", ZSChat: "readonly", ZSUi: "readonly",
};

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.js", "build/**/*.mjs", "test/**/*.js", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.browser, ...globals.node, chrome: "readonly" } },
    rules: { "no-undef": "error", "no-redeclare": "error", "no-use-before-define": ["error", { functions: false, classes: true, variables: true }] },
  },
  {
    files: ["test/**/*.cjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Adapters define ZSProvider; main.js (loaded after) consumes it.
    files: ["legacy/**/*.js"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: { ecmaVersion: 2023, sourceType: "script", globals: { ...globals.browser, chrome: "readonly", ...legacyGlobals } },
    rules: { "no-undef": "error", "no-redeclare": "error" },
  },
  {
    files: ["legacy/main.js"],
    languageOptions: { globals: { ZSProvider: "readonly" } },
  },
];
