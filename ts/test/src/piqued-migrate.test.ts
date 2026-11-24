import { PiquedUpgradeControl } from "@piqued/client";
import { PiquedUpgradeGraph, PiquedUpgradeInstance } from "@piqued/client/dist/upgrade-control/upgrade-graph.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const upgrade = (
    version: string,
    parents: string[],
    isolatedTx = false,
    nonTransactional = false,
): PiquedUpgradeInstance => ({
    version,
    name: version,
    upgrade: `-- upgrade ${version}`,
    downgrade: `-- downgrade ${version}`,
    parents,
    isolatedTx,
    nonTransactional,
});

/** `[[a, b], [c]]` -> `[["a", "b"], ["c"]]`, so plans are readable in assertions. */
const versions = (sequences: PiquedUpgradeInstance[][]) => sequences.map((seq) => seq.map((u) => u.version));

// v1 <- v2 <- v3 (isolated) <- v4
const linear = () =>
    PiquedUpgradeGraph.fromUpgrades([
        upgrade("v1", []),
        upgrade("v2", ["v1"]),
        upgrade("v3", ["v2"], true),
        upgrade("v4", ["v3"]),
    ]);

const tempDirs: string[] = [];

const makeUpgradeDir = async (
    upgrades: {
        dir: string;
        version: string;
        parents?: string[];
        isolatedTx?: boolean;
        nonTransactional?: boolean;
    }[],
) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "piqued-migrate-"));
    tempDirs.push(root);

    for (const u of upgrades) {
        const dir = path.join(root, u.dir);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "upgrade.sql"), `-- upgrade ${u.version}\n`);
        await fs.writeFile(path.join(dir, "downgrade.sql"), `-- downgrade ${u.version}\n`);

        const parents = (u.parents ?? []).map((p) => `"${p}"`).join(", ");
        await fs.writeFile(
            path.join(dir, "migration.toml"),
            `version = "${u.version}"\nisolatedTx = ${u.isolatedTx ?? false}\n` +
                (u.nonTransactional !== undefined ? `nonTransactional = ${u.nonTransactional}\n` : "") +
                `parents = [${parents}]\n`,
        );
    }

    return root;
};

afterEach(async () => {
    vi.restoreAllMocks();

    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe("PiquedUpgradeGraph", () => {
    it("reports the single head of a linear chain", () => {
        expect(linear().heads).toEqual(["v4"]);
    });

    it("reports every head of a branching graph", () => {
        const graph = PiquedUpgradeGraph.fromUpgrades([
            upgrade("v1", []),
            upgrade("v2a", ["v1"]),
            upgrade("v2b", ["v1"]),
        ]);

        expect(graph.heads.sort()).toEqual(["v2a", "v2b"]);
    });

    it("rejects graphs without exactly one root", () => {
        expect(() => PiquedUpgradeGraph.fromUpgrades([upgrade("a", ["missing"])])).toThrow(/No roots found/);
        expect(() => PiquedUpgradeGraph.fromUpgrades([upgrade("a", []), upgrade("b", [])])).toThrow(
            /Multiple roots found/,
        );
    });

    it("plans an initialization as a full topological walk", () => {
        const plan = linear().getInitializationPlan("v4");

        // v3 is `isolatedTx`, so it gets a transaction of its own.
        expect(versions(plan.upgrades)).toEqual([["v1", "v2"], ["v3"], ["v4"]]);
        expect(plan.downgrades).toEqual([]);
        expect(plan.target).toBe("v4");
    });

    it("plans only the missing upgrades when moving forward", () => {
        const plan = linear().getUpgradePlan("v1", "v4");

        expect(versions(plan.upgrades)).toEqual([["v2"], ["v3"], ["v4"]]);
        expect(plan.downgrades).toEqual([]);
    });

    it("plans downgrades in reverse when moving backward", () => {
        const plan = linear().getUpgradePlan("v4", "v2");

        expect(plan.upgrades).toEqual([]);
        expect(versions(plan.downgrades)).toEqual([["v4"], ["v3"]]);
    });

    it("plans both directions when switching branches", () => {
        const graph = PiquedUpgradeGraph.fromUpgrades([
            upgrade("v1", []),
            upgrade("v2a", ["v1"]),
            upgrade("v2b", ["v1"]),
        ]);

        const plan = graph.getUpgradePlan("v2a", "v2b");

        expect(versions(plan.upgrades)).toEqual([["v2b"]]);
        expect(versions(plan.downgrades)).toEqual([["v2a"]]);
    });

    it("isolates non-transactional upgrades into their own sequence", () => {
        const graph = PiquedUpgradeGraph.fromUpgrades([
            upgrade("v1", []),
            upgrade("v2", ["v1"]),
            upgrade("v3", ["v2"], false, true),
            upgrade("v4", ["v3"]),
        ]);

        expect(versions(graph.getInitializationPlan("v4").upgrades)).toEqual([["v1", "v2"], ["v3"], ["v4"]]);
    });

    it("resolves the head of an applied set only when it is unique", () => {
        const graph = PiquedUpgradeGraph.fromUpgrades([
            upgrade("v1", []),
            upgrade("a", ["v1"]),
            upgrade("b", ["v1"]),
            upgrade("c", ["a", "b"]),
        ]);

        expect(graph.headOf(new Set())).toBeNull();
        expect(graph.headOf(new Set(["v1", "a"]))).toBe("a");
        expect(graph.headOf(new Set(["v1", "a", "b"]))).toBeUndefined();
        expect(graph.headOf(new Set(["v1", "a", "b", "c"]))).toBe("c");
    });

    it("is a no-op when already at the target", () => {
        const plan = linear().getUpgradePlan("v3", "v3");

        expect(plan).toEqual({ upgrades: [], downgrades: [], target: "v3" });
    });

    it("does nothing for versions that are not in the graph", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(linear().getUpgradePlan("nope", "v4").upgrades).toEqual([]);
        expect(linear().getUpgradePlan("v1", "nope").upgrades).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(2);
    });
});

describe("PiquedUpgradeControl.fromDir", () => {
    it("loads upgrades, their sql, and their parents from disk", async () => {
        const root = await makeUpgradeDir([
            { dir: "0001-init#aaaaaa", version: "0001-init#aaaaaa" },
            { dir: "0002-person#bbbbbb", version: "0002-person#bbbbbb", parents: ["0001-init#aaaaaa"] },
        ]);

        const control = await PiquedUpgradeControl.fromDir(root);
        const graph = control.upgradeGraph;

        expect(graph.heads).toEqual(["0002-person#bbbbbb"]);
        expect(graph.get("0001-init#aaaaaa")?.upgrade).toBe("-- upgrade 0001-init#aaaaaa\n");
        expect(graph.get("0002-person#bbbbbb")?.downgrade).toBe("-- downgrade 0002-person#bbbbbb\n");
        expect(graph.get("0002-person#bbbbbb")?.parents).toEqual(["0001-init#aaaaaa"]);
    });

    it("recurses into directories that have no migration.toml", async () => {
        const root = await makeUpgradeDir([
            { dir: "old/0001", version: "0001" },
            { dir: "current/0002", version: "0002", parents: ["0001"], isolatedTx: true },
        ]);

        const control = await PiquedUpgradeControl.fromDir(root);
        const graph = control.upgradeGraph;

        expect(graph.heads).toEqual(["0002"]);
        expect(graph.get("0002")?.isolatedTx).toBe(true);
        expect(graph.get("0001")?.isolatedTx).toBe(false);
    });

    it("reads nonTransactional, defaulting to false", async () => {
        const root = await makeUpgradeDir([
            { dir: "0001", version: "0001" },
            { dir: "0002", version: "0002", parents: ["0001"], nonTransactional: true },
        ]);

        const graph = (await PiquedUpgradeControl.fromDir(root)).upgradeGraph;

        expect(graph.get("0001")?.nonTransactional).toBe(false);
        expect(graph.get("0002")?.nonTransactional).toBe(true);
    });

    it("skips directories whose migration.toml has no upgrade.sql", async () => {
        const root = await makeUpgradeDir([{ dir: "0001", version: "0001" }]);
        await fs.mkdir(path.join(root, "0002"));
        await fs.writeFile(path.join(root, "0002", "migration.toml"), `version = "0002"\nparents = ["0001"]\n`);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const graph = (await PiquedUpgradeControl.fromDir(root)).upgradeGraph;

        expect(graph.get("0002")).toBeUndefined();
        expect(graph.heads).toEqual(["0001"]);
        expect(warn).toHaveBeenCalled();
    });
});

/** Records the statements it sees; any migration sql containing FAIL throws. */
const fakeClient = (initialHead: string | null) => {
    const log: string[] = [];
    const db = { head: initialHead, committedHead: initialHead };

    const run = (sql: string, values: any[] = []) => {
        if (sql.includes("FAIL")) throw new Error("boom");
        if (sql.includes("SELECT head")) return { rows: [{ head: db.head }], rowCount: 1 };
        if (sql.includes("UPDATE _piqued_head")) {
            db.head = values[0];
            log.push(`head=${values[0]}`);
        } else {
            log.push(sql.trim());
        }
        return { rows: [], rowCount: 0 };
    };

    let inTx = false;
    const client: any = {
        query: async (sql: string, values?: any[]) => {
            const r = run(sql, values);
            if (!inTx) db.committedHead = db.head;
            return r;
        },
        q: async (strings: TemplateStringsArray, ...values: any[]) =>
            client.query(
                values.reduce((acc, _, i) => acc + `$${i + 1}` + strings[i + 1], strings[0]),
                values,
            ),
        q1: async (strings: TemplateStringsArray, ...values: any[]) => (await client.q(strings, ...values)).rows[0],
        tx: async (fn: (c: any) => any) => {
            log.push("BEGIN");
            inTx = true;
            const before = db.head;
            try {
                const r = await fn(client);
                log.push("COMMIT");
                db.committedHead = db.head;
                return r;
            } catch (e) {
                log.push("ROLLBACK");
                db.head = before;
                throw e;
            } finally {
                inTx = false;
            }
        },
    };

    return { client, log, db };
};

describe("PiquedUpgradeControl.upgradeToVersion", () => {
    const control = (failing?: string, nonTx: string[] = []) =>
        new PiquedUpgradeControl(
            ["v1", "v2", "v3", "v4"].map((v, i) => ({
                ...upgrade(v, i === 0 ? [] : [`v${i}`], false, nonTx.includes(v)),
                upgrade: v === failing ? `FAIL ${v}` : `-- upgrade ${v}`,
            })),
        );

    it("runs non-transactional steps outside a transaction and advances head per sequence", async () => {
        const { client, log, db } = fakeClient("v1");
        vi.spyOn(console, "log").mockImplementation(() => {});

        expect(await control(undefined, ["v3"]).upgradeToVersion(client)).toBe(true);

        const migration = log.slice(log.indexOf("COMMIT") + 1);
        expect(migration).toEqual([
            "BEGIN",
            "-- upgrade v2",
            "head=v2",
            "COMMIT",
            // Comment-only sql splits to no statements.
            "head=v3",
            "BEGIN",
            "-- upgrade v4",
            "head=v4",
            "COMMIT",
            "SELECT pg_advisory_unlock(hashtext('_piqued_head'))",
        ]);
        expect(log[0]).toBe("SELECT pg_advisory_lock(hashtext('_piqued_head'))");
        expect(db.committedHead).toBe("v4");
    });

    it("keeps committed progress when a later sequence fails", async () => {
        const { client, log, db } = fakeClient("v1");
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(control("v4", ["v3"]).upgradeToVersion(client)).rejects.toThrow("boom");

        expect(db.committedHead).toBe("v3");
        expect(log.at(-1)).toBe("SELECT pg_advisory_unlock(hashtext('_piqued_head'))");
    });

    it("sends non-transactional sql one statement at a time", async () => {
        const { client, log } = fakeClient("v1");
        vi.spyOn(console, "log").mockImplementation(() => {});

        const ctl = new PiquedUpgradeControl([
            upgrade("v1", []),
            { ...upgrade("v2", ["v1"], false, true), upgrade: "SELECT 1; SELECT ';';\n-- done" },
        ]);
        await ctl.upgradeToVersion(client);

        expect(log).toContain("SELECT 1");
        expect(log).toContain("SELECT ';'");
    });

    it("does not advance head past a failed non-transactional step", async () => {
        const { client, db } = fakeClient("v1");
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(control("v3", ["v3"]).upgradeToVersion(client)).rejects.toThrow("boom");

        expect(db.committedHead).toBe("v2");
    });
});
