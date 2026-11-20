import { defineConfig, globalIgnores } from "eslint/config";
import next from "@next/eslint-plugin-next";
import hooks from "eslint-plugin-react-hooks";
import ts from "typescript-eslint";

export default defineConfig([
  globalIgnores([".next/**", ".local/**", "next-env.d.ts", "src/generated/**", "test-results/**", "playwright-report/**"]),
  ...ts.configs.recommended,
  { files: ["**/*.{ts,tsx}"], extends: [next.configs["core-web-vitals"], hooks.configs.flat.recommended] },
]);
