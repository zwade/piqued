import { splitStatements } from "@piqued/client/dist/upgrade-control/split-statements.js";
import { describe, expect, it } from "vitest";

describe("splitStatements", () => {
    it.each([
        ["simple", "SELECT 1; SELECT 2;", ["SELECT 1", "SELECT 2"]],
        ["no trailing semicolon", "SELECT 1;\nSELECT 2", ["SELECT 1", "SELECT 2"]],
        ["empty statements", ";; SELECT 1;;\n;", ["SELECT 1"]],
        ["single quotes", "SELECT 'a;b'; SELECT 1", ["SELECT 'a;b'", "SELECT 1"]],
        ["doubled single quote", "SELECT 'it''s;'; SELECT 1", ["SELECT 'it''s;'", "SELECT 1"]],
        ["E-string backslash escape", "SELECT E'\\';'; SELECT 1", ["SELECT E'\\';'", "SELECT 1"]],
        ["lowercase e-string", "SELECT e'\\';'; SELECT 1", ["SELECT e'\\';'", "SELECT 1"]],
        ["identifier ending in e is not an E-string", "SELECT name'x;'; SELECT 1", ["SELECT name'x;'", "SELECT 1"]],
        ["standard string keeps backslash literal", "SELECT '\\'; SELECT 1", ["SELECT '\\'", "SELECT 1"]],
        ["quoted identifier", 'SELECT "a;""b"; SELECT 1', ['SELECT "a;""b"', "SELECT 1"]],
        ["line comment", "SELECT 1 -- a;b\n; SELECT 2", ["SELECT 1 -- a;b", "SELECT 2"]],
        ["block comment", "SELECT /* ; */ 1; SELECT 2", ["SELECT /* ; */ 1", "SELECT 2"]],
        ["nested block comment", "SELECT /* /* ; */ ; */ 1; SELECT 2", ["SELECT /* /* ; */ ; */ 1", "SELECT 2"]],
        ["comment-only fragments are dropped", "SELECT 1; -- trailing\n/* x; */", ["SELECT 1"]],
        ["dollar quote", "DO $$ BEGIN PERFORM 1; END $$; SELECT 1", ["DO $$ BEGIN PERFORM 1; END $$", "SELECT 1"]],
        [
            "tagged dollar quote containing $$",
            "DO $fn$ BEGIN RAISE '$$;'; END $fn$; SELECT 1",
            ["DO $fn$ BEGIN RAISE '$$;'; END $fn$", "SELECT 1"],
        ],
        ["dollar quote inside a string is ignored", "SELECT '$$'; SELECT 1", ["SELECT '$$'", "SELECT 1"]],
        ["positional params are not dollar quotes", "SELECT $1; SELECT $2", ["SELECT $1", "SELECT $2"]],
        ["$ inside identifier", "SELECT a$b; SELECT 1", ["SELECT a$b", "SELECT 1"]],
        [
            "CREATE INDEX CONCURRENTLY",
            "CREATE INDEX CONCURRENTLY i1 ON t (a);\nCREATE INDEX CONCURRENTLY i2 ON t (b);\n",
            ["CREATE INDEX CONCURRENTLY i1 ON t (a)", "CREATE INDEX CONCURRENTLY i2 ON t (b)"],
        ],
    ])("%s", (_name, sql, expected) => {
        expect(splitStatements(sql)).toEqual(expected);
    });
});
