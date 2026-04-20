import { Expression, TableBuilder } from "@piqued/client";

import { LiveviewEntry } from "./liveview.js";
import { Result } from "./result.js";

export type JoinEdge = [From: TableBuilder, To: TableBuilder, JoinCondition: Expression | null];

export const generateJoinTopography = (entry: LiveviewEntry): Result<JoinEdge[]> => {
    const graph = new Map<string, Map<string, JoinEdge>>();

    for (const join of entry.dependencies ?? []) {
        const [from, to, condition] = join;

        const fromEdge: JoinEdge = [from, to, condition];
        const existingForward = graph.get(from.name) ?? new Map();
        graph.set(from.name, existingForward.set(to.name, fromEdge));

        const toEdge: JoinEdge = [to, from, condition];
        const existingReverse = graph.get(to.name) ?? new Map();
        graph.set(to.name, existingReverse.set(from.name, toEdge));
    }

    const startNode = entry.primaryTable.name;
    const queue = [startNode];
    const visited = new Set<string>();

    const topology: JoinEdge[] = [];
    const unreachableTables = new Set(graph.keys());
    unreachableTables.delete(startNode);

    while (queue.length > 0) {
        const fromTable = queue.shift()!;
        if (visited.has(fromTable)) {
            continue;
        }

        visited.add(fromTable);

        for (const [toTable, edge] of graph.get(fromTable) ?? []) {
            if (visited.has(toTable)) {
                continue;
            }

            topology.push(edge);
            queue.push(edge[1].name);
            unreachableTables.delete(toTable);
        }
    }

    if (unreachableTables.size > 0) {
        return Result.err(
            new Error(
                `Unable to resolve join topography, remaining edges: ${[...unreachableTables.values()].join(", ")}`,
            ),
        );
    }

    const unreachableDeps = entry.triggers
        .map((dep) =>
            dep.kind === "column" && typeof dep.column !== "string"
                ? dep.column.tableName
                : dep.kind === "table"
                  ? dep.table.name
                  : null,
        )
        .filter((tableName) => tableName !== null)
        .filter((tableName) => !visited.has(tableName!));

    if (unreachableDeps.length > 0) {
        console.log(startNode, topology);

        return Result.err(
            new Error(
                `Unable to resolve join topography, remaining unreachable dependencies: ${unreachableDeps.join(", ")}`,
            ),
        );
    }

    return Result.ok(topology);
};

export const generateInverseJoinTopography = (entry: LiveviewEntry, startNode: string): Result<JoinEdge[]> => {
    const graph = new Map<string, Map<string, JoinEdge>>();

    for (const join of entry.dependencies ?? []) {
        const [from, to, condition] = join;

        const fromEdge: JoinEdge = [from, to, condition];
        const existingForward = graph.get(from.name) ?? new Map();
        graph.set(from.name, existingForward.set(to.name, fromEdge));

        const toEdge: JoinEdge = [to, from, condition];
        const existingReverse = graph.get(to.name) ?? new Map();
        graph.set(to.name, existingReverse.set(from.name, toEdge));
    }

    const queue = [startNode];
    const visited = new Set<string>();

    const topology: JoinEdge[] = [];

    while (queue.length > 0) {
        const fromTable = queue.shift()!;
        if (visited.has(fromTable)) {
            continue;
        }

        visited.add(fromTable);

        for (const [toTable, edge] of graph.get(fromTable) ?? []) {
            topology.push(edge);
            queue.push(edge[1].name);

            if (toTable === entry.primaryTable.name) {
                return Result.ok(topology);
            }
        }
    }

    return Result.err(
        new Error(`Unable to resolve inverse join topography from "${startNode}" to "${entry.primaryTable.name}"`),
    );
};
