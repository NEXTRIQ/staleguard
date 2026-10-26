// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          // node:test runs every test() it registers; the returned promise needs no handling.
          allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test"] }],
        },
      ],
      eqeqeq: ["error", "always"],
      // Output goes through process.stdout/stderr so every line is exactly one JSON record or message.
      "no-console": "error",
    },
  },
  {
    // Tooling config is plain JavaScript outside the TypeScript project.
    files: ["*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
