import { ColumnExpression } from "@piqued/client/dist/query-builder/expression-builder.js";
import crypto from "node:crypto";

import { LiveviewEntry } from "./liveview.js";

export const getPrimaryKeyColumn = (entry: LiveviewEntry): ColumnExpression<any, any> => {
    if (typeof entry.primaryKey === "string") {
        return entry.primaryTable.c[entry.primaryKey];
    }

    return entry.primaryKey;
};

export const getAssetName = (name: string) => {
    const hash = crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
    return `${hash}_${name.slice(0, 52)}`; // Postgres identifiers have a max length of 63 characters
};
