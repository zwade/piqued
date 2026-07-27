import { Op } from "@piqued/client";
import { compileCallbacks } from "@piqued/liveview/dist/callback-compiler.js";
import { LiveviewAsset, LiveviewEntry } from "@piqued/liveview/dist/liveview.js";
import { generateInverseJoinTopography, generateJoinTopography } from "@piqued/liveview/dist/topography.js";
import { compileTriggers } from "@piqued/liveview/dist/trigger-compiler.js";
import { getAssetName } from "@piqued/liveview/dist/utils.js";
import { describe, expect, it } from "vitest";

import { OrganizationTable, PersonTable, SessionTable } from "./fixtures/orm.js";

/** A `person`-rooted entry whose triggers and actions all live on `person`. */
const localEntry: LiveviewEntry = {
    id: "name_reconcile",
    primaryTable: PersonTable,
    primaryKey: PersonTable.c.id,
    primaryKeyType: "int",
    triggers: [
        { kind: "column", column: PersonTable.c.first_name },
        { kind: "column", column: PersonTable.c.last_name },
    ],
    actions: [
        {
            kind: "set",
            column: PersonTable.c.name,
            to: Op.concat(PersonTable.c.first_name, " ", PersonTable.c.last_name),
            async: false,
        },
    ],
};

/** A `person`-rooted entry driven by changes to the dependent `session` table. */
const joinedEntry: LiveviewEntry = {
    id: "session_reconcile",
    primaryTable: PersonTable,
    primaryKey: PersonTable.c.id,
    primaryKeyType: "int",
    dependencies: [[SessionTable, PersonTable, Op.eq(SessionTable.c.user_id, PersonTable.c.id)]],
    triggers: [{ kind: "column", column: SessionTable.c.last_active_at }],
    actions: [
        {
            kind: "set",
            column: PersonTable.c.last_active_at,
            to: SessionTable.c.last_active_at,
            async: true,
        },
    ],
};

const byKind = <K extends LiveviewAsset["kind"]>(assets: LiveviewAsset[], kind: K) =>
    assets.filter((a): a is Extract<LiveviewAsset, { kind: K }> => a.kind === kind);

describe("getAssetName", () => {
    it("is deterministic and fits inside a postgres identifier", () => {
        const name = getAssetName("liveview_trigger_fn_name_reconcile_person");

        expect(name).toBe(getAssetName("liveview_trigger_fn_name_reconcile_person"));
        expect(name.length).toBeLessThanOrEqual(63);
        expect(name).toMatch(/^[0-9a-f]{8}_liveview_trigger_fn_name_reconcile_person$/);
    });

    it("distinguishes names that share a truncated prefix", () => {
        const long = "liveview_sync_callback_" + "x".repeat(60);

        expect(getAssetName(long + "_a")).not.toBe(getAssetName(long + "_b"));
    });
});

describe("compileCallbacks", () => {
    it("emits a single sync function that updates the primary table", () => {
        const { sync, async } = compileCallbacks(localEntry);

        expect(async).toBeUndefined();
        expect(sync.kind).toBe("function");
        expect(sync.name).toBe(getAssetName("liveview_sync_callback_name_reconcile"));
        expect(sync.sql).toContain(`CREATE OR REPLACE FUNCTION "piqued_liveview"."${sync.name}"(uid int)`);
        expect(sync.sql).toContain('UPDATE "person"');
        expect(sync.sql).toContain(
            'SET "name" = (\n            SELECT concat("person"."first_name", \' \', "person"."last_name")',
        );
        expect(sync.sql).toContain('WHERE "person"."id" = $1');
    });

    it("splits async actions into their own function", () => {
        const { sync, async } = compileCallbacks(joinedEntry);

        expect(async).toBeDefined();
        expect(async!.name).toBe(getAssetName("liveview_async_callback_session_reconcile"));
        expect(async!.sql).toContain('SET "last_active_at" = (');
        expect(async!.sql).toContain('FROM "person" JOIN "session" ON ("session"."user_id" = "person"."id")');

        // The sync half only enqueues work for the host, naming the async callback to run after.
        expect(sync.sql).toContain('INSERT INTO "piqued_liveview"."host_fn_queue"');
        expect(sync.sql).toContain(`'${async!.name}'`);
        expect(sync.sql).not.toContain('SET "last_active_at"');
    });

    it("enqueues host work with a null async callback when the entry only has fn actions", () => {
        const { sync, async } = compileCallbacks({
            ...localEntry,
            actions: [{ kind: "fn", fn: async () => {} }],
        });

        expect(async).toBeUndefined();
        expect(sync.sql).toContain("VALUES ('name_reconcile', $1, NULL)");
    });

    it("refuses to set a column that is not on the primary table", () => {
        expect(() =>
            compileCallbacks({
                ...joinedEntry,
                actions: [{ kind: "set", column: SessionTable.c.last_active_at, to: null }],
            }),
        ).toThrow(/Can only update columns on the primary table/);
    });
});

describe("compileTriggers", () => {
    it("attaches column triggers directly to the primary table", () => {
        const assets = compileTriggers(localEntry);
        const triggers = byKind(assets, "trigger");

        expect(triggers).toHaveLength(2);
        expect(triggers.map((t) => t.triggerTable)).toEqual(["person", "person"]);
        expect(triggers[0].sql).toContain('AFTER INSERT OR UPDATE OF "first_name" OR DELETE ON "person"');
        expect(triggers[1].sql).toContain('AFTER INSERT OR UPDATE OF "last_name" OR DELETE ON "person"');

        // Both triggers share the one dispatch function, which is emitted exactly once.
        const fnName = getAssetName("liveview_trigger_fn_name_reconcile_person");
        expect(byKind(assets, "function").filter((f) => f.name === fnName)).toHaveLength(1);
        expect(triggers[0].sql).toContain(`EXECUTE FUNCTION "piqued_liveview"."${fnName}"()`);
        expect(triggers[1].sql).toContain(`EXECUTE FUNCTION "piqued_liveview"."${fnName}"()`);
    });

    it("routes a dependent table's changes back to the primary key via a join function", () => {
        const assets = compileTriggers(joinedEntry);
        const triggers = byKind(assets, "trigger");

        expect(triggers).toHaveLength(1);
        expect(triggers[0].triggerTable).toBe("session");
        expect(triggers[0].sql).toContain('ON "session"');

        const joinFn = assets.find((a) => a.name === getAssetName("liveview_join_session_reconcile_session"));
        expect(joinFn).toBeDefined();
        expect(joinFn!.sql).toContain('(_changed_row "session") RETURNS void');
        expect(joinFn!.sql).toContain("_pk int;");
        expect(joinFn!.sql).toContain('SELECT "person"."id"');
        // The changed row is aliased to `_base_row` so the join condition refers to it, not the table.
        expect(joinFn!.sql).toContain('JOIN "person" ON ("_base_row"."user_id" = "person"."id")');
    });

    it("records time triggers as rows rather than postgres triggers", () => {
        const assets = compileTriggers({
            ...localEntry,
            triggers: [{ kind: "time", column: PersonTable.c.created_at, to: "NOW" }],
        });

        const timeTriggers = byKind(assets, "time_trigger");
        expect(timeTriggers).toHaveLength(1);
        expect(byKind(assets, "trigger")).toHaveLength(0);

        expect(timeTriggers[0].sql).toContain('INSERT INTO "piqued_liveview"."time_trigger_state"');
        expect(timeTriggers[0].sql).toContain("'name_reconcile', 'person', 'created_at', 'id'");
        expect(timeTriggers[0].sql).toContain("'NOW()'");
        expect(timeTriggers[0].sql).toContain("ON CONFLICT (name) DO NOTHING");
    });

    it("emits a whole-table trigger for `table` triggers", () => {
        const assets = compileTriggers({
            ...localEntry,
            triggers: [{ kind: "table", table: PersonTable }],
        });

        const triggers = byKind(assets, "trigger");
        expect(triggers).toHaveLength(1);
        expect(triggers[0].sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON "person"');
    });

    it("fails when a trigger table cannot be joined back to the primary table", () => {
        expect(() =>
            compileTriggers({
                ...localEntry,
                triggers: [{ kind: "column", column: OrganizationTable.c.name }],
            }),
        ).toThrow(/Unable to (resolve|find join path)/);
    });
});

describe("join topography", () => {
    it("walks dependencies outward from the primary table", () => {
        const result = generateJoinTopography({
            ...joinedEntry,
            dependencies: [
                [SessionTable, PersonTable, Op.eq(SessionTable.c.user_id, PersonTable.c.id)],
                [OrganizationTable, PersonTable, Op.eq(OrganizationTable.c.owner_id, PersonTable.c.id)],
            ],
            triggers: [{ kind: "column", column: OrganizationTable.c.name }],
        });

        expect(result[0]).toBe(true);
        const edges = result[1] as [{ name: string }, { name: string }, unknown][];
        expect(edges.map(([from, to]) => `${from.name}->${to.name}`)).toEqual([
            "person->session",
            "person->organization",
        ]);
    });

    it("reports tables that are not reachable from the primary table", () => {
        const result = generateJoinTopography({
            ...localEntry,
            dependencies: [[SessionTable, OrganizationTable, Op.eq(SessionTable.c.user_id, OrganizationTable.c.id)]],
        });

        expect(result[0]).toBe(false);
        expect((result[1] as Error).message).toMatch(/Unable to resolve join topography/);
    });

    it("finds the reverse path from a dependent table to the primary table", () => {
        const result = generateInverseJoinTopography(joinedEntry, "session");

        expect(result[0]).toBe(true);
        const edges = result[1] as [{ name: string }, { name: string }, unknown][];
        expect(edges.map(([, to]) => to.name)).toEqual(["person"]);
    });

    it("errors when no reverse path exists", () => {
        const result = generateInverseJoinTopography(localEntry, "organization");

        expect(result[0]).toBe(false);
        expect((result[1] as Error).message).toMatch(/Unable to resolve inverse join topography/);
    });
});
