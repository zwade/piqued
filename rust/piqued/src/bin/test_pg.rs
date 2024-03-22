use std::env::{self, current_dir};

use piqued::{config::config::Config, query::query::Query};

#[tokio::main]
async fn main() {
    let working_dir = tokio::fs::canonicalize(env::current_dir().unwrap())
        .await
        .unwrap();

    let config_path = Config::find_dir(&working_dir).await;
    let config = Config::load(&config_path, &working_dir).await.unwrap();

    println!("Current config: {:#?}", config);

    let query = Query::new(&config).await.unwrap();
    let result = query
        .client
        .query("SELECT first_name FROM \"user\"", &[])
        .await
        .unwrap();
    for row in result {
        let col0: Option<&str> = row.get(0);
        println!("Result: {:#?}", col0);
    }
}
