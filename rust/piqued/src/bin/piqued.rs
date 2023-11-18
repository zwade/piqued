#![feature(try_trait_v2)]

use piqued::codegen::{codegen::CodeGenerationContext, ts::schema::TSGenerator};
use std::env::{self, current_dir};

use piqued::config::config::Config;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        println!("Usage: {} [working_dir]", args[0]);
        return;
    }

    let relative_path = if args.len() >= 2 {
        &args[1].as_str()
    } else {
        "."
    };

    let working_dir = current_dir().unwrap().join(relative_path);
    let config_path = working_dir.join(".piqued.toml");

    let config = Config::load(config_path.as_path().to_str()).await.unwrap();
    let codegen = CodeGenerationContext::new(working_dir.as_path(), &config).await;

    let ts_generator = TSGenerator::new();

    codegen.generate_system_types(&ts_generator).await;
    codegen.generate_queries(&ts_generator).await;
}
