import js from "@eslint/js";
import globals from "globals";

/**
 * The extension ships classic scripts (no bundler, no modules), while the
 * tooling uses ESM. Each group therefore gets its own source type and globals.
 */
export default [
  {
    ignores: ["node_modules/**", "dist/**", "*.zip", "coverage/**"]
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.node,
        chrome: "readonly",
        browser: "readonly"
      }
    },
    rules: {
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node
    }
  }
];
