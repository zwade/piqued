export type PiquedUpgradeInstance = {
    version: string;
    name: string;
    upgrade: string;
    downgrade: string | undefined;
    parents: string[];
    isolatedTx: boolean;
};

export type Operation = {
    upgrades: PiquedUpgradeInstance[][];
    downgrades: PiquedUpgradeInstance[][];
    target: string | null;
};

const constructSequence = (operations: PiquedUpgradeInstance[]): PiquedUpgradeInstance[][] => {
    const result: PiquedUpgradeInstance[][] = [[]];

    for (const operation of operations) {
        if (operation.isolatedTx) {
            result.push([operation], []);
        } else {
            const lastSequence = result[result.length - 1];
            lastSequence.push(operation);
        }
    }

    return result.filter((x) => x.length > 0);
};

export class PiquedUpgradeGraph {
    #nodes: Map<string, PiquedUpgradeInstance>;
    #root: string;
    #edges: Map<string, string[]>;

    public static fromUpgrades(upgrades: PiquedUpgradeInstance[]) {
        const nodes = new Map(upgrades.map((x) => [x.version, x]));
        const roots = [];
        const edges = new Map<string, string[]>();

        for (const upgrade of upgrades) {
            if (upgrade.parents.length === 0) {
                roots.push(upgrade.version);
            }

            for (const parent of upgrade.parents) {
                const children = edges.get(parent) ?? [];
                children.push(upgrade.version);
                edges.set(parent, children);
            }
        }

        if (roots.length === 0) {
            throw new Error("No roots found in upgrade graph");
        }

        if (roots.length > 1) {
            throw new Error("Multiple roots found in upgrade graph");
        }

        return new PiquedUpgradeGraph(nodes, roots[0], edges);
    }

    public constructor(nodes: Map<string, PiquedUpgradeInstance>, root: string, edges: Map<string, string[]>) {
        this.#nodes = nodes;
        this.#root = root;
        this.#edges = edges;
    }

    public get heads() {
        const heads: string[] = [];

        for (const node of this.#nodes.values()) {
            const edges = this.#edges.get(node.version) ?? [];
            if (edges.length === 0) {
                heads.push(node.version);
            }
        }

        return heads;
    }

    private isolateSubgraph(end: string): Set<string> {
        const visited = new Set<string>();
        const queue: string[] = [end];

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) {
                continue;
            }

            visited.add(current);
            const parents = this.#nodes.get(current)?.parents ?? [];
            for (const parent of parents) {
                queue.push(parent);
            }
        }

        return visited;
    }

    private toposort(target: string): string[] {
        const visited = new Set<string>();
        const result: string[] = [];

        const dfs = (nodeId: string) => {
            if (visited.has(nodeId)) {
                return;
            }

            visited.add(nodeId);

            const node = this.#nodes.get(nodeId)!;
            for (const parent of node.parents) {
                dfs(parent);
            }

            result.push(nodeId);
        };

        dfs(target);
        return result;
    }

    private filteredToposort(target: string, exclude: Set<string>): string[] {
        return this.toposort(target).filter((x) => !exclude.has(x));
    }

    public getUpgradePlan(currentVersion: string, targetVersion: string): Operation {
        const result: Operation = { upgrades: [], downgrades: [], target: targetVersion };

        if (currentVersion === targetVersion) {
            return result;
        }

        if (!this.#nodes.has(currentVersion)) {
            console.warn(`Current version ${currentVersion} not found in graph`);
            return result;
        }

        if (!this.#nodes.has(targetVersion)) {
            console.warn(`Target version ${targetVersion} not found in graph`);
            return result;
        }

        const targetSubgraph = this.isolateSubgraph(targetVersion);
        const currentSubgraph = this.isolateSubgraph(currentVersion);

        const missingUpgrades = [...targetSubgraph].filter((x) => !currentSubgraph.has(x));
        const missingDowngrades = [...currentSubgraph].filter((x) => !targetSubgraph.has(x));

        if (missingUpgrades.length !== 0) {
            const upgrades = this.filteredToposort(targetVersion, currentSubgraph);
            result.upgrades = constructSequence(upgrades.map((x) => this.#nodes.get(x)!));
        }

        if (missingDowngrades.length !== 0) {
            const downgrades = this.filteredToposort(currentVersion, targetSubgraph).reverse();
            result.downgrades = constructSequence(downgrades.map((x) => this.#nodes.get(x)!));
        }

        return result;
    }

    public getInitializationPlan(targetNode: string): Operation {
        const upgrades = constructSequence(this.toposort(targetNode).map((x) => this.#nodes.get(x)!));

        return { upgrades, downgrades: [], target: targetNode };
    }

    public get(node: string) {
        return this.#nodes.get(node);
    }

    public toString() {
        console.log([...this.#nodes].map((x) => x[1].version));
        console.log([...this.#edges].map(([a, bs]) => `${a} -> ${bs.join(", ")}`));
    }
}
