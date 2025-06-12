import { dispatchLog } from "./pq-log";
import { dispatchLegacyUpgrade } from "./pq-migration";
import { dispatchNew } from "./pq-new";

const help = () => {
    process.stdout.write(`Usage: piqued-migrate <command>
Commands:
    help              Show this help message
    new               Generate a new migration
    log               Show the history of migrations
    legacy-upgrade    Upgrade a set of migrations from the legacy format
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
        case "new":
            await dispatchNew(process.argv.slice(3));
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
