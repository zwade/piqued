import { serializeExpressionAsString } from "@piqued/client";

import { compileCallbacks } from "./callback-compiler.js";
import { LiveviewAsset, LiveviewEntry } from "./liveview.js";
import { generateInverseJoinTopography } from "./topography.js";
import { getAssetName, getPrimaryKeyColumn } from "./utils.js";

const primaryTableOf = (entry: LiveviewEntry) => entry.primaryTable.name;
const pkCol = (entry: LiveviewEntry) => getPrimaryKeyColumn(entry).columnName;

const compilePrimaryTriggerFunction = (entry: LiveviewEntry, callbackName: string): LiveviewAsset => {
    const table = primaryTableOf(entry);
    const fnName = getAssetName(`liveview_trigger_fn_${entry.id}_${table}`);
    const col = pkCol(entry);

    const triggerSql = `CREATE OR REPLACE FUNCTION "piqued_liveview"."${fnName}"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM "piqued_liveview"."${callbackName}"(OLD."${col}");
    ELSE
        PERFORM "piqued_liveview"."${callbackName}"(NEW."${col}");
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;`;

    return {
        kind: "function",
        name: fnName,
        sql: triggerSql,
    };
};

const compilePrimaryTimeTriggerFunction = (entry: LiveviewEntry, callbackName: string): LiveviewAsset => {
    const table = primaryTableOf(entry);
    const fnName = getAssetName(`liveview_time_trigger_fn_${entry.id}_${table}`);
    const col = pkCol(entry);

    const triggerSql = `CREATE OR REPLACE FUNCTION "piqued_liveview"."${fnName}"(primary_row "${table}") RETURNS void AS $$
BEGIN
    PERFORM "piqued_liveview"."${callbackName}"(primary_row."${col}");
END;
$$ LANGUAGE plpgsql;`;

    return {
        kind: "function",
        name: fnName,
        sql: triggerSql,
    };
};

const compileJoinFunction = (entry: LiveviewEntry, depTableName: string, callbackName: string): LiveviewAsset => {
    const topology = generateInverseJoinTopography(entry, depTableName);
    if (topology[0] === false) {
        throw new Error(
            `Unable to find join path from "${depTableName}" to "${primaryTableOf(entry)}": ${topology[1].message}`,
        );
    }

    const edges = topology[1];
    if (edges.length === 0) {
        throw new Error(`No join edges found from "${depTableName}" to "${primaryTableOf(entry)}"`);
    }

    const table = primaryTableOf(entry);
    const col = pkCol(entry);
    const fnName = getAssetName(`liveview_join_${entry.id}_${depTableName}`);

    const tableNameMap: Record<string, string> = { [depTableName]: "_base_row" };

    const joinClauses: string[] = [];
    for (const [_fromTable, toTable, condition] of edges) {
        const condSql = serializeExpressionAsString(condition, { tableNameMap });
        joinClauses.push(`JOIN "${toTable.name}" ON ${condSql}`);
    }

    const joinsSql = joinClauses.length > 0 ? `\n        ${joinClauses.join("\n        ")}` : "";
    const selectSql = `SELECT "${table}"."${col}"
        FROM (SELECT _changed_row.*) _base_row${joinsSql}`;

    const fnSql = `CREATE OR REPLACE FUNCTION "piqued_liveview"."${fnName}"(_changed_row "${depTableName}") RETURNS void AS $$
DECLARE
    _pk ${entry.primaryKeyType};
BEGIN
    FOR _pk IN (
        ${selectSql}
    ) LOOP
        PERFORM "piqued_liveview"."${callbackName}"(_pk);
    END LOOP;
END;
$$ LANGUAGE plpgsql;`;

    return {
        kind: "function",
        name: fnName,
        sql: fnSql,
    };
};

const compileJoinTrigger = (
    entry: LiveviewEntry,
    depTableName: string,
    callbackName: string,
): { fn: LiveviewAsset; trigger: LiveviewAsset } => {
    const fnName = getAssetName(`liveview_join_trigger_fn_${entry.id}_${depTableName}`);

    const joinFn = compileJoinFunction(entry, depTableName, callbackName);

    const fnSql = `CREATE OR REPLACE FUNCTION "piqued_liveview"."${fnName}"() RETURNS trigger AS $$
DECLARE
    _changed_row "${depTableName}"%ROWTYPE;
    _pk ${entry.primaryKeyType};
BEGIN
    IF TG_OP = 'DELETE' THEN _changed_row := OLD; ELSE _changed_row := NEW; END IF;
    PERFORM "piqued_liveview"."${joinFn.name}"(_changed_row);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;`;

    const trigger: LiveviewAsset = {
        kind: "function",
        name: fnName,
        sql: fnSql,
    };

    return { fn: trigger, trigger: joinFn };
};

export const compileTriggers = (entry: LiveviewEntry): LiveviewAsset[] => {
    const primaryTable = primaryTableOf(entry);

    const assets: LiveviewAsset[] = [];

    const emittedAssets = new Set<string>();
    const emit = (asset: LiveviewAsset) => {
        if (emittedAssets.has(asset.name)) return;
        emittedAssets.add(asset.name);
        assets.push(asset);
    };

    const callbackFns = compileCallbacks(entry);
    emit(callbackFns.sync);
    if (callbackFns.async) {
        emit(callbackFns.async);
    }

    for (const dep of entry.triggers) {
        switch (dep.kind) {
            case "column": {
                const depTable = typeof dep.column === "string" ? primaryTable : dep.column.tableName;
                const colName = typeof dep.column === "string" ? dep.column : dep.column.columnName;
                const isExternal = depTable !== primaryTable;

                let triggerName: string;
                let callbackFnName: string;

                if (isExternal) {
                    const { fn: joinFn, trigger: joinTrigger } = compileJoinTrigger(
                        entry,
                        depTable,
                        callbackFns.sync.name,
                    );

                    triggerName = getAssetName(`liveview_trigger_${entry.id}_${depTable}`);
                    callbackFnName = joinFn.name;

                    emit(joinFn);
                    emit(joinTrigger);
                } else {
                    const primaryTriggerFn = compilePrimaryTriggerFunction(entry, callbackFns.sync.name);

                    triggerName = getAssetName(`liveview_trigger_${entry.id}_${primaryTable}_${colName}`);
                    callbackFnName = primaryTriggerFn.name;

                    emit(primaryTriggerFn);
                }

                emit({
                    kind: "trigger",
                    name: triggerName,
                    sql: `CREATE OR REPLACE TRIGGER "${triggerName}"
AFTER INSERT OR UPDATE OF "${colName}" OR DELETE ON "${depTable}"
FOR EACH ROW EXECUTE FUNCTION "piqued_liveview"."${callbackFnName}"();`,
                    triggerTable: depTable,
                });

                break;
            }
            case "table": {
                const depTable = dep.table.name;
                const isExternal = depTable !== primaryTable;

                let triggerName: string;
                let callbackFnName: string;

                if (isExternal) {
                    const { fn: joinFn, trigger: joinTrigger } = compileJoinTrigger(
                        entry,
                        depTable,
                        callbackFns.sync.name,
                    );

                    triggerName = getAssetName(`liveview_trigger_${entry.id}_${depTable}`);
                    callbackFnName = joinFn.name;

                    emit(joinFn);
                    emit(joinTrigger);
                } else {
                    const primaryTriggerFn = compilePrimaryTriggerFunction(entry, callbackFns.sync.name);

                    triggerName = getAssetName(`liveview_trigger_${entry.id}_${primaryTable}`);
                    callbackFnName = primaryTriggerFn.name;

                    emit(primaryTriggerFn);
                }

                emit({
                    kind: "trigger",
                    name: triggerName,
                    sql: `CREATE OR REPLACE TRIGGER "${triggerName}"
AFTER INSERT OR UPDATE OR DELETE ON "${depTable}"
FOR EACH ROW EXECUTE FUNCTION "piqued_liveview"."${callbackFnName}"();`,
                    triggerTable: depTable,
                });

                break;
            }
            case "time": {
                const depTable = dep.column.tableName;
                const colName = dep.column.columnName;

                const from = dep.from === "NOW" ? "NOW()" : dep.from;
                const to = dep.to === "NOW" ? "NOW()" : dep.to;
                const primaryKeyName = pkCol(entry);

                const isExternal = depTable !== primaryTable;

                let triggerName: string;
                let callbackFnName: string;

                if (isExternal) {
                    const joinFn = compileJoinFunction(entry, depTable, callbackFns.sync.name);

                    triggerName = getAssetName(`liveview_time_trigger_${entry.id}_${depTable}_${colName}`);
                    callbackFnName = joinFn.name;

                    emit(joinFn);
                } else {
                    const primaryTriggerFn = compilePrimaryTimeTriggerFunction(entry, callbackFns.sync.name);

                    triggerName = getAssetName(`liveview_time_trigger_${entry.id}_${primaryTable}_${colName}`);
                    callbackFnName = primaryTriggerFn.name;

                    emit(primaryTriggerFn);
                }

                emit({
                    kind: "time_trigger",
                    name: triggerName,
                    sql: `INSERT INTO "piqued_liveview"."time_trigger_state" (name, entry_id, table_name, column_name, primary_key_name, callback_name, start_time, end_time)
VALUES (${serializeExpressionAsString(triggerName)}, ${serializeExpressionAsString(entry.id)}, ${serializeExpressionAsString(depTable)}, ${serializeExpressionAsString(colName)}, ${serializeExpressionAsString(primaryKeyName)}, ${serializeExpressionAsString(callbackFnName)}, ${serializeExpressionAsString(from)}, ${serializeExpressionAsString(to)})
ON CONFLICT (name) DO NOTHING;`,
                });
            }
        }
    }

    return assets;
};
