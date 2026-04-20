import type { ColumnBuilder, Expression, SmartClient, TableBuilder } from "@piqued/client";

export type LiveviewDependency = [From: TableBuilder, To: TableBuilder, Condition: Expression];
export type Dependency = { table: TableBuilder<any, any>; row: Record<string, unknown> };

export type LiveviewTrigger =
    | { kind: "column"; column: string; when?: Expression }
    | { kind: "column"; column: ColumnBuilder<any, any>; when?: Expression }
    | { kind: "table"; table: TableBuilder<any, any>; when?: Expression }
    | { kind: "time"; column: ColumnBuilder<any, any>; from?: Date | "NOW"; to?: Date | "NOW" };

export type LiveviewAction =
    | { kind: "set"; column: string | ColumnBuilder<any, any>; to: Expression; async?: boolean }
    | {
          kind: "fn";
          fn: (client: SmartClient, dependencies: Record<string, Record<string, unknown>>) => Promise<void>;
      };

export type LiveviewEntry = {
    id: string;
    primaryTable: TableBuilder<any, any>;
    primaryKey: ColumnBuilder<any, any> | string;
    primaryKeyType: "text" | "uuid" | string;
    triggers: LiveviewTrigger[];
    actions: LiveviewAction[];
    dependencies?: LiveviewDependency[];
};

export type LiveviewAsset =
    | { kind: "trigger"; name: string; sql: string; triggerTable: string }
    | { kind: "function"; name: string; sql: string; triggerTable?: undefined }
    | { kind: "time_trigger"; name: string; sql: string; triggerTable?: undefined };

export type LiveviewAssetType = LiveviewAsset["kind"];
