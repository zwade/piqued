
use piqued::{parser::parser, query::query::Query};
use tokio::fs;
use std::env;

use piqued::config::config::Config;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        println!("Usage: {} <file>", args[0]);
        return;
    }

    let config = Config::load(None).await.unwrap();

    let contents = fs::read_to_string(&args[1]).await.unwrap();
    let data = parser::load_file(&contents);
    let query = Query::new(&config).await.unwrap();

    // println!("Tables: {:#?}", query.tables);
    // println!("Types: {:#?}", query.custom_types_by_name);

    match data {
        Ok(data) => {
            for stmt in data.statements {
                // println!("{:#?}", stmt.stmt.clone());
                let prepared_statement = parser::get_prepared_statement(stmt.clone(), &data.tokens, &contents);

                if let Ok(stmt) = prepared_statement {
                    let res = query.probe_type(&stmt).await.unwrap();
                    println!("Details: {:#?}", stmt.details);
                    println!("{:#?}", res);
                }
            }
        },
        Err(e) => {
            println!("Error: {:#?}", e);
        }
    }
}
