use pg_query::{protobuf::{RawStmt, ParseResult}};
use tokio::spawn;
use tokio_postgres::{NoTls, connect, Client, types::Type};

use crate::parser::parser::{ParsedPreparedQuery, parse_arg, Result};

#[derive(Debug)]
pub struct Query {
    pub client: Client,
}

#[derive(Debug)]
pub struct ProbeResponse {
    pub args: Vec<String>,
    pub column_types: Vec<String>,
    pub column_names: Vec<String>,
}

impl Query {
    pub async fn new() -> Result<Query> {
        let (client, connection) =
            connect("postgresql://postgres:hola12@127.0.0.1:5432/postgres", NoTls).await?;

        spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("connection error: {}", e);
            }
        });

        Ok(Query { client })
    }

    pub async fn probe_type(&self, stmt: &ParsedPreparedQuery) -> Result<ProbeResponse> {
        let as_prepared_statement: ParseResult = ParseResult {
            stmts: vec![
                RawStmt {
                    stmt: stmt.query.stmt.clone(),

                    stmt_len: 0,
                    stmt_location: 0,
                },
            ],
            version: 130003,
        };

        let prepared_statement = as_prepared_statement.deparse().unwrap();
        let argtypes: Vec<Type> =
            stmt.variables
            .iter()
            .filter_map(|node| parse_arg(node.clone()))
            .collect();

        let results = self.client
            .prepare_typed(&prepared_statement, argtypes.as_slice())
            .await?;

        let args = results.params().into_iter().map(|typ| type_to_string(typ).to_string()).collect::<Vec<String>>();
        let column_types = results.columns().into_iter().map(|col| type_to_string(col.type_()).to_string()).collect::<Vec<String>>();
        let column_names = results.columns().into_iter().map(|col| col.name().to_string()).collect::<Vec<String>>();

        return Ok(ProbeResponse {
            args,
            column_types,
            column_names,
        });
    }
}

pub fn type_to_string<'a>(type_: &'a Type) -> &'a str {
    type_.name()
}

