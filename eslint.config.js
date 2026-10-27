import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-captain/**",
      "**/out/**",
      "**/release/**",
      "**/.vite/**",
      "workers/**",
      ".claude/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
  {
    // CommonJS Node scripts (Playwright drivers); page.evaluate bodies run in the browser.
    files: ["scripts/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", __dirname: "readonly", module: "writable", document: "readonly", location: "readonly", window: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // The program's connection settings page runs in its sandboxed window (classic script).
    files: ["apps/desktop/connect/**/*.js"],
    languageOptions: { sourceType: "script", globals: { document: "readonly", window: "readonly" } },
  },
  {
    // Example HUD packages run in the browser.
    files: ["examples/**/*.js"],
    languageOptions: { globals: { document: "readonly", location: "readonly", URLSearchParams: "readonly", performance: "readonly", WebSocket: "readonly" } },
  },
);
