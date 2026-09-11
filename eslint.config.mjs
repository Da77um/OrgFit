import tseslint from "typescript-eslint";
import next from "@next/eslint-plugin-next";
export default [
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/.next/**",
      "**/next-env.d.ts",
      "node_modules/**",
      "work/**",
      "test-results/**",
      // Vendored runtime that ships with the brand identity canvas package.
      // It is reference material, not product source.
      "docs/identityreference/**",
      "playwright-report/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@next/next": next },
    rules: {
      ...next.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
    settings: { next: { rootDir: ["apps/staff/", "apps/respondent/"] } },
  },
];
