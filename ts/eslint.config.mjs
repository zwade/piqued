import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import teslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";

const compat = new FlatCompat({
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});
const OFF = "off";
const WARN = "warn";
const ERROR = "error";

export default teslint.config(
    js.configs.recommended,
    eslintConfigPrettier,
    eslintPluginPrettierRecommended,
    teslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },

            ecmaVersion: 12,
            sourceType: "module",

            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,

                ecmaFeatures: {
                    jsx: true,
                },
            },
        },

        plugins: {
            "simple-import-sort": simpleImportSort,

        },

        rules: {
            "linebreak-style": [ERROR, "unix"],
            "@typescript-eslint/explicit-module-boundary-types": OFF,
            "eol-last": WARN,

            "simple-import-sort/imports": [
                ERROR,
                {
                    groups: [
                        ["^\\u0000.*(?<!\\.s?css)$"],
                        ["^(@)?\\w"],
                        ["^(?!(\\.|@\\/))"],
                        ["^@\\/"],
                        ["^\\."],
                        ["\\.s?css$"],
                    ],
                },
            ],

            "simple-import-sort/exports": ERROR,
            "object-curly-spacing": [ERROR, "always"],

            "@typescript-eslint/no-unused-vars": [
                WARN,
                {
                    varsIgnorePattern: "(^_)|(React)",
                    argsIgnorePattern: "(^_)|(props)",
                    args: "after-used",
                },
            ],

            "@typescript-eslint/no-non-null-assertion": OFF,
            "@typescript-eslint/no-namespace": OFF,
            "@typescript-eslint/no-explicit-any": OFF,

            "prefer-const": [
                ERROR,
                {
                    destructuring: "all",
                },
            ],

            "@typescript-eslint/no-empty-interface": OFF,
            "@typescript-eslint/no-empty-function": OFF,
            "@typescript-eslint/naming-convention": OFF,
            "@typescript-eslint/no-empty-object-type": OFF,
            "@typescript-eslint/no-unsafe-function-type": OFF,

            "no-inner-declarations": OFF,
            "@typescript-eslint/no-non-null-asserted-optional-chain": OFF,
            "no-constant-condition": OFF,
            "no-async-promise-executor": OFF,
            "@typescript-eslint/ban-types": OFF,
        },
    },
    globalIgnores(["**/queries.ts", "**/postgres.ts", "**/orm.ts", "*.json", "**/*.json"]),
    {
        files: ["**/.*.js", "**/*.json"],

        rules: {
            "@typescript-eslint/naming-convention": OFF,
        },
    },
);
