#![feature(try_trait_v2)]

use clap::{value_parser, Arg, ArgAction, Command};
use notify::{DebouncedEvent, RecursiveMode, Watcher};
use piqued::workspace::workspace::Workspace;
use std::sync::mpsc::channel;
use std::time::Duration;
use std::{env, path::PathBuf, sync::Arc};
use tokio::fs;

use piqued::config::config::Config;

#[derive(Debug)]
struct CliOptions {
    pub config_path: Option<String>,
    pub watch: bool,
    pub no_emit: bool,
    pub verbose: bool,
}

fn get_args() -> CliOptions {
    let matches = Command::new("piqued_lsp")
        .version("0.1.0")
        .author("Zach Wade <zach@dttw.tech>")
        .arg(
            Arg::new("config")
                .short('c')
                .long("config")
                .required(false)
                .num_args(1)
                .action(ArgAction::Set)
                .value_parser(value_parser!(PathBuf)),
        )
        .arg(
            Arg::new("watch")
                .short('w')
                .long("watch")
                .required(false)
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("no-emit")
                .long("no-emit")
                .required(false)
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("verbose")
                .short('v')
                .long("verbose")
                .required(false)
                .action(ArgAction::SetTrue),
        )
        .get_matches();

    let config_path = matches.get_one::<String>("config").map(|x| x.to_owned());
    let watch = matches.get_one::<bool>("watch").unwrap_or(&false);
    let no_emit = matches.get_one::<bool>("no-emit").unwrap_or(&false);
    let verbose = matches.get_one::<bool>("verbose").unwrap_or(&false);

    CliOptions {
        config_path,
        watch: watch.clone(),
        no_emit: no_emit.clone(),
        verbose: verbose.clone(),
    }
}

async fn compile_one(workspace: &Workspace, options: &CliOptions) {
    if options.no_emit {
        if options.verbose {
            println!("Not emitting code");
            println!("Typecheck-only-mode not currently supported");
        }

        return;
    }

    let result = workspace.gen_code().await;
    if let Err(e) = result {
        eprintln!("Error generating code: {:?}", e);
    }

    return;
}

async fn compile_on_change(workspace: &mut Workspace, options: &CliOptions) {
    let (tx, rx) = channel();
    let mut watcher = notify::watcher(tx, Duration::from_millis(200)).unwrap();

    let dir_to_watch = workspace
        .config
        .workspace
        .root
        .clone()
        .unwrap_or_else(|| workspace.root_dir.clone());

    watcher
        .watch(dir_to_watch, RecursiveMode::Recursive)
        .unwrap();

    loop {
        match rx.recv() {
            Ok(
                DebouncedEvent::Write(p)
                | DebouncedEvent::Create(p)
                | DebouncedEvent::Remove(p)
                | DebouncedEvent::Rename(p, _),
            ) => {
                if workspace.is_compile_target(&p).await {
                    println!("Change detected, recompiling...");
                    compile_one(workspace, options).await;
                }
            }
            Ok(e) => {
                if options.verbose {
                    println!("Ignoring event: {:?}", e);
                }
            }
            Err(e) => {
                println!("Error while watching for changes:\n{:?}", e);
                return;
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let args = get_args();

    let working_dir = fs::canonicalize(env::current_dir().unwrap()).await.unwrap();
    let base_path = if let Some(config_path) = &args.config_path {
        Config::find_file(&fs::canonicalize(config_path).await.unwrap()).await
    } else {
        Config::find_dir(&working_dir).await
    };

    let Some(path) = &base_path else {
        panic!("No config file found in working directory or parent directories");
    };

    if args.verbose {
        println!("Working directory: {:?}", base_path);
        println!("Found config path: {:?}", path);
    }

    let config = Config::load(&Some(path.clone()), &working_dir)
        .await
        .unwrap();

    let root = config.workspace.root.as_ref().unwrap().clone();
    let mut workspace = Workspace::new(Arc::new(config), root).await;

    if args.watch {
        compile_on_change(&mut workspace, &args).await;
    } else {
        println!("Compiling...");
        compile_one(&workspace, &args).await;
    }
}
