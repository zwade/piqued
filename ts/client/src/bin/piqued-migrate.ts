import { dispatchInit } from "./pq-init.js";
import { dispatchLog } from "./pq-log.js";
import { dispatchLegacyUpgrade } from "./pq-migration.js";
import { dispatchNew } from "./pq-new.js";
import { dispatchUpgrade } from "./pq-upgrade.js";

const help = () => {
    process.stdout.write(`Usage: piqued-migrate <command>
Commands:
    help              Show this help message
    init              Initialize a new piqued migration directory
    new               Generate a new migration
    log               Show the history of migrations
    upgrade           Upgrade the database to a specific version
    legacy-upgrade    (Deprecated) Upgrade a set of migrations from the legacy format
`);
};

const main = async () => {
    const [_node, _script, cmd] = process.argv;

    if (!cmd) {
        help();
        process.exit(1);
    }

    switch (cmd) {
        case "help":
            help();
            break;
        case "init":
            await dispatchInit(process.argv.slice(3));
            break;
        case "new":
            await dispatchNew(process.argv.slice(3));
            break;
        case "upgrade":
            await dispatchUpgrade(process.argv.slice(3));
            break;
        case "legacy-upgrade":
            await dispatchLegacyUpgrade(process.argv.slice(3));
            break;
        case "log":
            await dispatchLog(process.argv.slice(3));
            break;
        default:
            help();
            process.exit(1);
    }
};

main();
