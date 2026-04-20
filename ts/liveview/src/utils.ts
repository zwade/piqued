import { ColumnExpression } from "@piqued/client/dist/query-builder/expression-builder.js";

import { LiveviewEntry } from "./liveview.js";

export const getPrimaryKeyColumn = (entry: LiveviewEntry): ColumnExpression<any, any> => {
    if (typeof entry.primaryKey === "string") {
        return entry.primaryTable.c[entry.primaryKey];
    }

    return entry.primaryKey;
};
