import globals from "globals";

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
];
