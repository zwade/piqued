import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { parse } from "smol-toml";

export interface PiquedConfig {
    postgres: PostgresConfig;
    emit: EmitConfig;
    workspace: WorkspaceConfig;
}

export interface PostgresConfig {
    uri: string;
    schema: string;
}

export interface EmitConfig {
    typeFile: string;
    moduleType: string;
    tableFile?: string;
}

export interface WorkspaceConfig {
    root?: string;
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export const PiquedConfig = {
    withDefault: (config: DeepPartial<PiquedConfig>, workingDir?: string): PiquedConfig => ({
        postgres: {
            uri: "postgresql://postgres:password@localhost:5432/postgres",
            schema: "public",
            ...(config.postgres ?? {}),
        },
        emit: {
            typeFile: "./types",
            moduleType: "esm",
            ...(config.emit ?? {}),
        },
        workspace: {
            root: workingDir,
            ...(config.workspace ?? {}),
        },
    }),

    async findDir(dir: string): Promise<string | null> {
        const file = nodePath.join(dir, "piqued.toml");
        return await PiquedConfig.findFile(file);
    },

    async findFile(file: string): Promise<string | null> {
        const fileName = nodePath.basename(file);
        let currentDir = nodePath.dirname(file);

        while (true) {
            const candidate = nodePath.join(currentDir, fileName);
            try {
                await fs.access(candidate);
                return candidate;
            } catch {
                const parentDir = nodePath.dirname(currentDir);
                if (parentDir === currentDir) {
                    return null;
                }

                currentDir = parentDir;
            }
        }
    },

    async load(file: string | null, workingDir: string): Promise<PiquedConfig> {
        if (file !== null) {
            try {
                const contents = await fs.readFile(file, "utf-8");
                const parsed = parse(contents) as Partial<PiquedConfig>;

                return PiquedConfig.withDefault(parsed, workingDir);
            } catch (e) {
                throw new Error(`Failed to load config from ${file}: ${(e as Error).message}`);
            }
        }

        return PiquedConfig.withDefault({}, workingDir);
    },
};
