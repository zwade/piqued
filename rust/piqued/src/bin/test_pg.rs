use std::{
    env::{self},
    sync::Arc,
};

use piqued::{
    config::config::Config, loose_parser::parse::ParserContext, parser::parser::load_file,
    query::query::Query,
};

#[tokio::main]
async fn main() {
    let config_str = "
[postgres]
uri=\"postgresql://postgres:password@localhost:5432/postgres\"
";
    let config: Config = toml::from_str(config_str).unwrap();
    let query = Query::new(Arc::new(config)).await.unwrap();

    let input = "
PREPARE reflect AS
    SELECT $1::text || ' from postgres!' AS input;

-- @name reflect_2
-- @params first second
SELECT $1::text || ' from another postgres!', $2 AS input;

SELECT 'This query has messy characters: \\ ` ''';

-- @xtemplate uids (uuid_generate_v4())
PREPARE test AS
    SELECT uid FROM person
    WHERE
        uid IN :uids OR
        $1;
";

    let stmts = load_file(input).unwrap();
    let result = query.probe_type(&stmts.statements[3]).await.unwrap();

    println!("Result: {:#?}", result);

    // let working_dir = tokio::fs::canonicalize(env::current_dir().unwrap())
    //     .await
    //     .unwrap();

    // let config_path = Config::find_dir(&working_dir).await;
    // let config = Config::load(&config_path, &working_dir).await.unwrap();

    // println!("Current config: {:#?}", config);

    // let query = Query::new(Arc::new(config)).await.unwrap();
    // let result = query
    //     .client
    //     .query("SELECT first_name FROM \"user\"", &[])
    //     .await
    //     .unwrap();
    // for row in result {
    //     let col0: Option<&str> = row.get(0);
    //     println!("Result: {:#?}", col0);
    // }
}
