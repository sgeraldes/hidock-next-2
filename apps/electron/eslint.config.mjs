import { createRequire } from "module";
import { defineConfig } from "eslint/config";
import eslintReact from "@eslint-react/eslint-plugin";
import localRules from "./eslint-local-rules.mjs";

const require = createRequire(import.meta.url);
const { configs } = require("@electron-toolkit/eslint-config-ts");

// rules-of-hooks is the one correctness rule this gate most needs (a real
// hooks-order crash happened in this codebase). It lives in
// eslint-plugin-react-hooks; wire it in defensively so the config still loads
// if the package is ever removed, but it is a declared devDependency.
let reactHooksPlugin = null;
try {
  reactHooksPlugin = require("eslint-plugin-react-hooks");
} catch {
  reactHooksPlugin = null;
}

const reactHooksConfig = reactHooksPlugin
  ? [
      {
        files: ["src/**/*.{ts,tsx,js,jsx}"],
        plugins: { "react-hooks": reactHooksPlugin },
        rules: {
          "react-hooks/rules-of-hooks": "error",
          "react-hooks/exhaustive-deps": "warn",
        },
      },
    ]
  : [];

// defineConfig comes from ESLint itself; typescript-eslint 8.70 deprecated the
// `config()` helper that @electron-toolkit/eslint-config-ts re-exports.
export default defineConfig(
  // Base: @eslint/js recommended + typescript-eslint recommended (NOT
  // type-checked — keeps the gate fast) + browser/node globals.
  ...configs.recommended,

  // Relax stylistic / low-signal rules so the gate reflects real problems.
  // These are downgraded (not fixed) because fixing them means touching dozens
  // of files across the codebase, which is out of scope for restoring the gate.
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      // @ts-ignore/@ts-expect-error comment discipline — noisy, not correctness.
      "@typescript-eslint/ban-ts-comment": "warn",
      // `Function` type usage — legitimate cleanup, but 14 sites across files.
      "@typescript-eslint/no-unsafe-function-type": "warn",
      // Redundant regex escapes — auto-fixable but touches many regexes; warn.
      "no-useless-escape": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },

  // Renderer (React) — src/**
  //
  // These are the rules eslint-plugin-react's recommended set enabled, carried
  // over one by one to @eslint-react (eslint-plugin-react stops at ESLint 9.7).
  // The set is deliberately not @eslint-react's own recommended preset, which
  // adds dozens of rules the old gate never had. Recommended rules with no
  // @eslint-react counterpart are covered by tsc (jsx-no-duplicate-props,
  // jsx-no-undef, no-is-mounted: `npm run typecheck` reports all three), by the
  // scope analysis of ESLint and typescript-eslint (jsx-uses-vars), or by
  // eslint-local-rules.mjs (require-render-return, no-string-refs,
  // no-unescaped-entities, the react-dom part of no-deprecated). tsc misses
  // require-render-return because ReactNode includes undefined. The old
  // react-in-jsx-scope, jsx-uses-react and prop-types were off and stay gone.
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    plugins: { "@eslint-react": eslintReact, "hidock-local": localRules },
    settings: { "react-x": { version: "detect" } },
    rules: {
      // react/jsx-key
      "@eslint-react/no-missing-key": "error",
      // react/jsx-no-comment-textnodes
      "@eslint-react/jsx-no-comment-textnodes": "error",
      // react/jsx-no-target-blank
      "@eslint-react/dom-no-unsafe-target-blank": "error",
      // react/no-children-prop
      "@eslint-react/jsx-no-children-prop": "error",
      // react/no-danger-with-children
      "@eslint-react/dom-no-dangerously-set-innerhtml-with-children": "error",
      // react/no-deprecated
      "@eslint-react/dom-no-render": "error",
      "@eslint-react/dom-no-hydrate": "error",
      "@eslint-react/no-component-will-mount": "error",
      "@eslint-react/no-component-will-receive-props": "error",
      "@eslint-react/no-component-will-update": "error",
      "hidock-local/no-deprecated-react-dom": "error",
      // react/no-direct-mutation-state
      "@eslint-react/no-direct-mutation-state": "error",
      // react/no-find-dom-node
      "@eslint-react/dom-no-find-dom-node": "error",
      // react/no-render-return-value
      "@eslint-react/dom-no-render-return-value": "error",
      // react/no-string-refs
      "hidock-local/no-string-refs": "error",
      // react/require-render-return
      "hidock-local/require-render-return": "error",
      // Low-signal stylistic rules downgraded to warnings.
      // react/no-unescaped-entities
      "hidock-local/no-unescaped-entities": "warn",
      // react/display-name
      "@eslint-react/no-missing-component-display-name": "warn",
      // react/no-unknown-property
      "@eslint-react/dom-no-unknown-property": "warn",
    },
  },

  // react-hooks (conditional — see note above)
  ...reactHooksConfig,

  // CommonJS files (main-process bootstrap, root-level benchmark/util scripts)
  // legitimately use require().
  {
    files: ["electron/**/*.{ts,js,mjs,cjs}", "**/*.js", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "out/**",
      "coverage/**",
      "resources/**",
      // Python virtualenvs (speaker-linking worker) ship vendored JS bundles.
      "**/.venv*/**",
      "**/*.config.js",
      "**/*.config.cjs",
      "**/*.config.mjs",
      "**/*.config.ts",
      "**/*.tsbuildinfo",
    ],
  },
);
