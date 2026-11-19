import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/**", "dist-ssr/**", "dist-server/**", "node_modules/**"] },
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
    plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
    },
  },
];
