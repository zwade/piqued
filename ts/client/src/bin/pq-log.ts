#!/usr/bin/env node

import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { PiquedUpgradeControl } from "../upgrade-control/control";
import { PiquedUpgradeInstance } from "../upgrade-control/upgrade-graph";
import { RleMatrix, Segment } from "./render-buffer";

const help = () => {
    process.stdout.write(`Usage: piqued-migrate log <upgrade dir>
Description:
    Shows the history of migrations in the upgrade directory.
Options:
    -h, --help        Show this help message
    --noPager         Disable the pager and output directly to the console
`);
};

interface CellData {
    column: number;
    node: PiquedUpgradeInstance;
}

class GraphPaintBuffer {
    private buffer: RleMatrix;
    private activeThreads: Map<string, { columns: Set<number> }> = new Map(); // id -> starting column
    private currentRow: number = 0;

    public constructor() {
        this.buffer = new RleMatrix(0, 0, undefined, {});
    }

    public drawActiveThreads(height: number) {
        for (const { columns } of this.activeThreads.values()) {
            for (const column of columns) {
                this.buffer.copyIn(
                    { y: this.currentRow, x: column * 4 },
                    RleMatrix.fromAscii("|".repeat(height), { width: 1 }),
                );
            }
        }
    }

    public drawEdges(destinations: CellData[]) {
        const edges = destinations.flatMap(({ node, column: endColumn }) =>
            [...(this.activeThreads.get(node.version)?.columns ?? [])].map((startColumn) => ({
                startColumn,
                endColumn,
                node,
            })),
        );

        const largestCrossing = edges.reduce((max, { startColumn, endColumn }) => {
            return Math.max(max, Math.abs(startColumn - endColumn));
        }, 0);

        const neededHeight = Math.max(largestCrossing * 4 - 1, 1);

        for (const { startColumn, endColumn, node } of edges) {
            const start = startColumn * 4;
            const end = endColumn * 4;

            const distance = Math.abs(start - end);
            for (let i = 0; i < neededHeight; i++) {
                if (i > distance - 1) {
                    this.buffer.setAscii({ y: this.currentRow + i, x: end }, "|");
                } else if (start < end) {
                    this.buffer.setAscii({ y: this.currentRow + i, x: start + i + 1 }, "\\");
                } else {
                    this.buffer.setAscii({ y: this.currentRow + i, x: start - i - 1 }, "/");
                }
            }

            this.activeThreads.delete(node.version);
        }

        this.drawActiveThreads(neededHeight);
        // end
        this.currentRow += neededHeight;
    }

    public drawRankData(data: CellData[], isFirst: boolean = false) {
        const asSorted = data.slice().sort((a, b) => a.column - b.column);

        this.drawActiveThreads(asSorted.length);

        // First draw the connections
        for (let i = 0; i < asSorted.length; i++) {
            const { column, node } = asSorted[i];
            const isLast = node.parents.length === 0;

            if (!isFirst && i > 0) {
                this.buffer.copyIn(
                    { y: this.currentRow, x: column * 4 },
                    RleMatrix.fromAscii("|".repeat(i), { width: 1 }),
                );
            }

            if (!isLast && i < asSorted.length - 1) {
                this.buffer.copyIn(
                    { y: this.currentRow + i + 1, x: column * 4 },
                    RleMatrix.fromAscii("|".repeat(i + 1), { width: 1 }),
                );
            }
        }

        // Then draw the nodes (which may overwrite the connections)
        for (let i = 0; i < asSorted.length; i++) {
            const { column, node } = asSorted[i];

            const textData = "* " + node.version + " ";
            const segments: Segment[] = [Segment.fromAscii(textData, { color: isFirst ? "yellow" : "green" })];

            if (node.parents.length > 1) {
                segments.push(Segment.fromAscii("parents: {", { color: "gray" }));
                for (let i = 0; i < node.parents.length; i++) {
                    const parent = node.parents[i];
                    segments.push(Segment.fromAscii(parent, { color: "blue" }));

                    if (i < node.parents.length - 1) {
                        segments.push(Segment.fromAscii(", ", { color: "gray" }));
                    }
                }
                segments.push(Segment.fromAscii("}", { color: "gray" }));
            }

            this.buffer.copyIn({ y: this.currentRow + i, x: column * 4 }, RleMatrix.fromArray([segments]));
        }

        for (const { node, column } of data) {
            for (const parent of node.parents) {
                const parentData = this.activeThreads.get(parent);
                if (parentData) {
                    parentData.columns.add(column);
                } else {
                    this.activeThreads.set(parent, { columns: new Set([column]) });
                }
            }
        }

        this.currentRow += asSorted.length;
    }

    public addRank(data: CellData[], rank: number) {
        if (data.length === 0) {
            return;
        }

        if (rank === 0) {
            this.drawRankData(data, true);
        } else {
            this.drawEdges(data);
            this.drawRankData(data, false);
        }
    }

    public toString() {
        const buffer: string[] = [];

        for (const line of this.buffer) {
            buffer.push(line.toString());
        }

        return buffer.join("\n");
    }
}

export const dispatchLog = async (argv: string[]) => {
    const { values, positionals } = parseArgs({
        options: {
            help: {
                type: "string",
                short: "h",
            },
            noPager: {
                type: "boolean",
                default: false,
            },
        },
        allowPositionals: true,
        args: argv,
    });

    const [directory] = positionals;
    if (!directory || values.help) {
        help();
        process.exit(0);
    }

    const control = await PiquedUpgradeControl.fromDir(directory);
    const graph = control.upgradeGraph.planarGraph;

    const byRank = new Map<number, string[]>();
    for (const [id, { rank }] of graph) {
        if (!byRank.has(rank)) {
            byRank.set(rank, []);
        }

        byRank.get(rank)!.push(id);
    }

    const result = new GraphPaintBuffer();

    const sortedEntries = [...byRank.entries()].sort((a, b) => a[0] - b[0]);
    for (const [rank, ids] of sortedEntries) {
        const data = ids.map((id) => graph.get(id)!);
        result.addRank(data, rank);
    }

    if (values.noPager) {
        process.stdout.write(result.toString());
        process.stdout.write("\n");

        return;
    } else {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pq-log-"));
        const tmpFile = `${tmpDir}/log.txt`;

        try {
            await fs.writeFile(tmpFile, result.toString());
            cp.execSync(`less ${tmpFile}`, { stdio: "inherit" });
        } finally {
            await fs.unlink(tmpFile);
        }
    }
};
