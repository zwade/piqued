use piqued::{config::config::Config, query::query::Query};

#[tokio::main]
async fn main() {
    let config = Config::load(None).await.unwrap();

    println!("Current config: {:#?}", config);

    let query = Query::new(&config).await.unwrap();
    let result = query
        .client
        .query("SELECT name FROM \"user\"", &[])
        .await
        .unwrap();
    for row in result {
        let col0: &str = row.get(0);
        println!("Result: {:#?}", col0);
    }
}
