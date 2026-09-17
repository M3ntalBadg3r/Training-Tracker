import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Allow deliberately-discarded variables/args (and destructure-to-drop
    // patterns like `{ id: _id, ...rest }`) to use the `_` prefix convention.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees: the Claude Code harness checks this same repo out under
    // `.claude/worktrees/<agent>/`, and a worktree that has been built carries
    // its own `.next/` and `node_modules/`. The patterns above are root-anchored
    // (`.next/**`, not `**/.next/**`), so a nested build directory is NOT
    // covered by them — one agent session was enough to turn `npm run lint`
    // into 130k findings, none of them in `src/`. CI never sees this (it lints a
    // fresh checkout), which is exactly why it has to be handled here: the
    // person it breaks is the one running the checks locally before pushing.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
