import { serializeExpressionAsString } from "@piqued/client";

import { LiveviewAsset, LiveviewEntry } from "./liveview.js";
import { generateJoinTopography } from "./topography.js";
import { getPrimaryKeyColumn } from "./utils.js";

const generateFunctionSql = (
    functionName: string,
    primaryKeyType: string,
    statements: string[],
) => `CREATE OR REPLACE FUNCTION "piqued_liveview"."${functionName}"(uid ${primaryKeyType}) RETURNS void AS $$
BEGIN
    ${statements.join("\n    ")}
END;
$$ LANGUAGE plpgsql;`;

export const compileCallbacks = (entry: LiveviewEntry): { sync: LiveviewAsset; async?: LiveviewAsset } => {
    const requiresHost = entry.actions.some((callback) => callback.kind === "fn");
    const inlineCallbacks = entry.actions.filter((callback) => callback.kind === "set");

    const syncStatements: string[] = [];
    const asyncStatements: string[] = [];

    const syncFunctionName = `liveview_sync_callback_${entry.id}`;
    const asyncFunctionName = `liveview_async_callback_${entry.id}`;

    const joins = generateJoinTopography(entry);
    if (joins[0] === false) {
        throw new Error(`Unable to generate join topography: ${joins[1].message}`);
    }

    const joinStatements = joins[1].map(([_from, to, condition]) => {
        const conditionSql = serializeExpressionAsString(condition);
        return `JOIN "${to.name}" ON ${conditionSql}`;
    });

    const fromStatement = `FROM "${entry.primaryTable.name}" ${joinStatements.join(" ")}`;

    for (const callback of inlineCallbacks) {
        let columnName: string;
        if (typeof callback.column === "string") {
            columnName = callback.column;
        } else {
            if (callback.column.tableName !== entry.primaryTable.name) {
                throw new Error("Can only update columns on the primary table");
            }

            columnName = callback.column.columnName;
        }

        const primaryKeyExp = getPrimaryKeyColumn(entry);
        const statement = `UPDATE "${entry.primaryTable.name}"
        SET "${columnName}" = (
            SELECT ${serializeExpressionAsString(callback.to)}
            ${fromStatement}
            WHERE ${serializeExpressionAsString(primaryKeyExp)} = $1
            LIMIT 1
        )
        WHERE ${serializeExpressionAsString(primaryKeyExp)} = $1;`;

        if (callback.async) {
            asyncStatements.push(statement);
        } else {
            syncStatements.push(statement);
        }
    }

    if (requiresHost || asyncStatements.length > 0) {
        const asyncFunction = asyncStatements.length > 0 ? asyncFunctionName : null;

        syncStatements.push(
            `INSERT INTO "piqued_liveview"."host_fn_queue" (entry_id, primary_key, async_callback_name) VALUES (${serializeExpressionAsString(entry.id)}, $1, ${serializeExpressionAsString(asyncFunction)});`,
        );
    }

    const syncCallback: LiveviewAsset = {
        kind: "function",
        name: syncFunctionName,
        sql: generateFunctionSql(syncFunctionName, entry.primaryKeyType, syncStatements),
    };

    const asyncCallback: LiveviewAsset | undefined =
        asyncStatements.length > 0
            ? {
                  kind: "function",
                  name: asyncFunctionName,
                  sql: generateFunctionSql(asyncFunctionName, entry.primaryKeyType, asyncStatements),
              }
            : undefined;

    return {
        sync: syncCallback,
        async: asyncCallback,
    };
};
