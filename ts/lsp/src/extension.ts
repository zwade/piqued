import { type ExtensionContext, commands, workspace } from "vscode";
import os from "os";

import {
    Executable,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
    const options: Executable = {
        command: "piqued_lsp",
        transport: TransportKind.stdio,
        options: {
            env: { ...process.env, RUST_LOG: "debug" },
            cwd: workspace.workspaceFolders?.[0]?.uri?.fsPath ?? os.homedir(),
        },
    }

    const serverOptions: ServerOptions = {
        run: options,
        debug: options,
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ language: "pgsql" }, { language: "plaintext" }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher("**/*.{sql,pgsql,psql}"),
        }
    };

    client = new LanguageClient(
        "Piqued",
        "Piqued Language Server",
        serverOptions,
        clientOptions,
        true
    );

    client.start();

    context.subscriptions.push(commands.registerCommand("piqued.restart", () => {
        client.stop().then(() => client.start(), () => client.start());
    }));
}

export function deactivate(): Thenable<void> | undefined {
    console.log("Deactivating server");
    if (!client) {
        return undefined;
    }
    return client.stop();
}
