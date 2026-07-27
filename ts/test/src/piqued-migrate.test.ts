import { PiquedUpgradeControl } from "@piqued/client";
import { PiquedUpgradeGraph, PiquedUpgradeInstance } from "@piqued/client/dist/upgrade-control/upgrade-graph.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const upgrade = (version: string, parents: string[], isolatedTx = false): PiquedUpgradeInstance => ({
    version,
    name: version,
    upgrade: `-- upgrade ${version}`,
    downgrade: `-- downgrade ${version}`,
    parents,
    isolatedTx,
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
    upgrades: { dir: string; version: string; parents?: string[]; isolatedTx?: boolean; legacy?: boolean }[],
) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "piqued-migrate-"));
    tempDirs.push(root);

    for (const u of upgrades) {
        const dir = path.join(root, u.dir);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "upgrade.sql"), `-- upgrade ${u.version}\n`);
        await fs.writeFile(path.join(dir, "downgrade.sql"), `-- downgrade ${u.version}\n`);

        if (!u.legacy) {
            const parents = (u.parents ?? []).map((p) => `"${p}"`).join(", ");
            await fs.writeFile(
                path.join(dir, "migration.toml"),
                `version = "${u.version}"\nisolatedTx = ${u.isolatedTx ?? false}\nparents = [${parents}]\n`,
            );
        }
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
            { dir: "legacy/0001", version: "legacy_1" },
            { dir: "current/0002", version: "0002", parents: ["legacy_1"], isolatedTx: true },
        ]);

        const control = await PiquedUpgradeControl.fromDir(root);
        const graph = control.upgradeGraph;

        expect(graph.heads).toEqual(["0002"]);
        expect(graph.get("0002")?.isolatedTx).toBe(true);
        expect(graph.get("legacy_1")?.isolatedTx).toBe(false);
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

describe("PiquedUpgradeControl.migrateUpgradeDir", () => {
    it("converts numbered legacy upgrades into a chained, toml-described graph", async () => {
        const root = await makeUpgradeDir([
            { dir: "1", version: "1", legacy: true },
            { dir: "2", version: "2", legacy: true },
        ]);

        await PiquedUpgradeControl.migrateUpgradeDir(root);

        expect(await fs.readdir(root)).toEqual(["legacy"]);
        expect(await fs.readdir(path.join(root, "legacy"))).toEqual(["1", "2"]);

        const graph = (await PiquedUpgradeControl.fromDir(root)).upgradeGraph;

        expect(graph.heads).toEqual(["legacy_2"]);
        expect(graph.get("legacy_1")?.parents).toEqual([]);
        expect(graph.get("legacy_2")?.parents).toEqual(["legacy_1"]);
    });

    it("leaves upgrades that already have a migration.toml alone", async () => {
        const root = await makeUpgradeDir([{ dir: "1", version: "already-migrated" }]);

        await PiquedUpgradeControl.migrateUpgradeDir(root);

        expect((await fs.readdir(root)).sort()).toEqual(["1", "legacy"]);
        expect(await fs.readdir(path.join(root, "legacy"))).toEqual([]);
    });
});
