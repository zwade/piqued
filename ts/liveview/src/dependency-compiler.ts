import { Op, QueryState, Select, SmartClient } from "@piqued/client";

import { LiveviewEntry } from "./liveview.js";
import { generateJoinTopography } from "./topography.js";
import { getPrimaryKeyColumn } from "./utils.js";

export const compileDependencyQuery = async (client: SmartClient, entry: LiveviewEntry, key: string) => {
    const topography = generateJoinTopography(entry);
    if (topography[0] === false) {
        throw new Error(`Unable to generate join topography: ${topography[1].message}`);
    }

    const edges = topography[1];
    const tables = edges.reduce((acc, [, to]) => acc.add(to), new Set([entry.primaryTable.table]));

    let query: QueryState<any> = Select(...tables).from(entry.primaryTable);
    for (const [_from, to, condition] of edges) {
        query = query.innerJoin(to, condition!);
    }

    const primaryKeyExp = getPrimaryKeyColumn(entry);
    return await query.where(Op.eq(primaryKeyExp, key)).enableExperimentalMangle().one(client);
};
