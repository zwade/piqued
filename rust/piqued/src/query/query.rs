use std::{collections::HashMap, sync::Arc};

use pg_query::{
    protobuf::{ParseResult, RawStmt},
    Node, NodeEnum,
};
use tokio::spawn;
use tokio_postgres::{
    connect,
    types::{Kind, Type},
    Client, NoTls,
};

use crate::{
    config::config::Config,
    parser::parser::{node_to_string, RelocatedStmt},
    utils::result::Result,
};

#[derive(Debug)]
pub struct Query {
    pub client: Client,
    pub tables: HashMap<String, Vec<Column>>,
    pub custom_types_by_oid: HashMap<u32, Arc<CustomType>>,
    pub custom_types_by_name: HashMap<String, Arc<CustomType>>,
    pub config: Arc<Config>,
}

#[derive(Debug, PartialEq, PartialOrd, Eq, Ord)]
pub struct Column {
    pub name: String,
    pub type_name: String,
    pub type_oid: u32,
    pub nullable: bool,
}

#[derive(Debug, PartialEq, PartialOrd, Eq, Ord)]
pub struct CompositeType {
    pub oid: u32,
    pub name: String,
    pub fields: Vec<Column>,
}

#[derive(Debug, PartialEq, PartialOrd, Ord, Eq)]
pub struct EnumType {
    pub oid: u32,
    pub name: String,
    pub values: Vec<String>,
}

#[derive(Debug, PartialEq, PartialOrd, Ord, Eq)]
pub enum CustomType {
    Composite(CompositeType),
    Enum(EnumType),
}

#[derive(Debug)]
pub struct ProbeResponse {
    pub args: Vec<String>,
    pub column_types: Vec<String>,
    pub column_names: Vec<String>,
}

impl Query {
    pub async fn new(config: Arc<Config>) -> Result<Query> {
        let (client, connection) = connect(&config.postgres.uri, NoTls).await?;

        spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("connection error: {}", e);
            }
        });

        let mut query = Query {
            client,
            tables: HashMap::new(),
            custom_types_by_oid: HashMap::new(),
            custom_types_by_name: HashMap::new(),
            config: config.clone(),
        };

        query.load_table_schema(&config).await?;
        query.load_custom_types(&config).await?;

        Ok(query)
    }

    pub async fn probe_type(&self, stmt: &RelocatedStmt) -> Result<ProbeResponse> {
        let as_prepared_statement: ParseResult = ParseResult {
            stmts: vec![stmt.stmt.as_ref()?.clone()],
            version: 160001,
        };

        let prepared_statement = as_prepared_statement.deparse().unwrap();
        let argtypes: Vec<Type> = stmt
            .variables
            .iter()
            .filter_map(|node| self.parse_arg(node.clone()))
            .collect();

        let results = self
            .client
            .prepare_typed(&prepared_statement, argtypes.as_slice())
            .await?;

        let args = results
            .params()
            .into_iter()
            .map(|typ| type_to_string(typ).to_string())
            .collect::<Vec<String>>();
        let column_types = results
            .columns()
            .into_iter()
            .map(|col| type_to_string(col.type_()).to_string())
            .collect::<Vec<String>>();
        let column_names = results
            .columns()
            .into_iter()
            .map(|col| col.name().to_string())
            .collect::<Vec<String>>();

        return Ok(ProbeResponse {
            args,
            column_types,
            column_names,
        });
    }

    async fn load_table_schema(&mut self, config: &Config) -> Result<()> {
        let columns = self
            .client
            .query(
                "
                SELECT
                    table_name,
                    column_name,
                    udt_name as data_type,
                    coalesce(pg_type.oid, -1) as type_oid,
                    is_nullable,
                    ordinal_position
                FROM information_schema.columns
                    LEFT JOIN pg_type ON pg_type.typname = udt_name
                WHERE table_schema = $1
                ORDER BY table_name, ordinal_position
            ",
                &[&config.postgres.schema.as_str()],
            )
            .await?;

        let tables: HashMap<String, Vec<Column>> =
            columns.into_iter().fold(HashMap::new(), |mut acc, row| {
                let table_name = row.get(0);
                let column_name = row.get(1);
                let type_name = row.get(2);
                let type_oid = row.get(3);
                let is_nullable_str = row.get(4);

                let nullable = match is_nullable_str {
                    "YES" => true,
                    "NO" => false,
                    _ => false,
                };

                let column = Column {
                    name: column_name,
                    type_name,
                    type_oid,
                    nullable,
                };

                acc.entry(table_name).or_insert_with(Vec::new).push(column);

                acc
            });

        self.tables = tables;
        Ok(())
    }

    async fn load_custom_types(&mut self, config: &Config) -> Result<()> {
        let composite_types_query = self.client.query(
            "
                SELECT
                    pg_type.typname as type_name,
                    pg_type.oid as type_oid,
                    pg_attribute.attname as col_name,
                    pg_attribute.atttypid as col_type_oid,
                    col_type.typname as col_type_name,
                    not pg_attribute.attnotnull as col_nullable
                FROM pg_type
                INNER JOIN pg_namespace
                    ON pg_type.typnamespace = pg_namespace.oid
                INNER JOIN pg_attribute
                    ON pg_type.typrelid = pg_attribute.attrelid
                INNER JOIN pg_type col_type
                    ON pg_attribute.atttypid = col_type.oid
                WHERE pg_namespace.nspname in ($1, 'pg_catalog')
                    AND pg_type.typcategory = 'C'
                    AND pg_attribute.attnum > 0
                    AND pg_type.typname NOT LIKE '%_seq' -- CR zwade for zwade: is there a better way to do this?
                ORDER BY
                    pg_type.oid ASC,
                    pg_attribute.attnum ASC
            ",
            &[&config.postgres.schema.as_str()]
        ).await?;

        let composite_types_by_oid = composite_types_query
            .into_iter()
            .fold(HashMap::new(), |mut acc, row| {
                let type_name = row.get(0);
                let type_oid = row.get(1);
                let col_name = row.get(2);
                let col_type_oid = row.get(3);
                let col_type_name = row.get(4);
                let col_nullable = row.get(5);

                let column = Column {
                    name: col_name,
                    type_name: col_type_name,
                    type_oid: col_type_oid,
                    nullable: col_nullable,
                };

                let composite_type = acc.entry(type_oid).or_insert_with(|| CompositeType {
                    oid: type_oid,
                    name: type_name,
                    fields: Vec::new(),
                });

                composite_type.fields.push(column);

                acc
            })
            .into_iter()
            .map(|(oid, composite_type)| (oid, Arc::new(CustomType::Composite(composite_type))))
            .collect::<HashMap<_, _>>();

        let composite_types_by_name = composite_types_by_oid
            .iter()
            .map(|(_, composite_type)| match composite_type.as_ref() {
                CustomType::Composite(t) => (t.name.clone(), Arc::clone(composite_type)),
                _ => panic!("Expected composite type"),
            })
            .collect::<HashMap<_, _>>();

        let enum_types_query = self
            .client
            .query(
                "
                SELECT
                    pg_type.typname as type_name,
                    pg_type.oid as type_oid,
                    pg_enum.enumlabel as enum_value
                FROM pg_type
                INNER JOIN pg_namespace
                    ON pg_type.typnamespace = pg_namespace.oid
                INNER JOIN pg_enum
                    ON pg_type.oid = pg_enum.enumtypid
                WHERE pg_namespace.nspname in ($1, 'pg_catalog')
                    AND pg_type.typcategory = 'E'
                ORDER BY
                    pg_type.oid ASC,
                    pg_enum.enumsortorder ASC
            ",
                &[&config.postgres.schema.as_str()],
            )
            .await?;

        let enum_types_by_oid = enum_types_query
            .into_iter()
            .fold(HashMap::new(), |mut acc, row| {
                let type_name = row.get(0);
                let type_oid = row.get(1);
                let enum_value = row.get(2);

                let enum_type = acc.entry(type_oid).or_insert_with(|| EnumType {
                    oid: type_oid,
                    name: type_name,
                    values: Vec::new(),
                });

                enum_type.values.push(enum_value);

                acc
            })
            .into_iter()
            .map(|(oid, composite_type)| (oid, Arc::new(CustomType::Enum(composite_type))))
            .collect::<HashMap<_, _>>();

        let enum_types_by_name = enum_types_by_oid
            .iter()
            .map(|(_, composite_type)| match composite_type.as_ref() {
                CustomType::Enum(t) => (t.name.clone(), Arc::clone(composite_type)),
                _ => panic!("Expected composite type"),
            })
            .collect::<HashMap<_, _>>();

        let mut custom_types_by_oid = HashMap::new();
        custom_types_by_oid.extend(composite_types_by_oid);
        custom_types_by_oid.extend(enum_types_by_oid);

        let mut custom_types_by_name = HashMap::new();
        custom_types_by_name.extend(composite_types_by_name);
        custom_types_by_name.extend(enum_types_by_name);

        self.custom_types_by_oid = custom_types_by_oid;
        self.custom_types_by_name = custom_types_by_name;

        Ok(())
    }

    pub fn parse_arg(&self, node: Node) -> Option<Type> {
        let typ = node.node?;

        match typ {
            NodeEnum::TypeName(tn) => {
                let last_name = tn.names.last()?;
                let name = node_to_string(last_name.clone())?;

                if let Some(custom_type) = self.custom_types_by_name.get(&name) {
                    let type_ = match custom_type.as_ref() {
                        CustomType::Composite(t) => Some(Type::new(
                            t.name.clone(),
                            t.oid,
                            Kind::Simple,
                            "public".to_string(),
                        )),
                        CustomType::Enum(t) => Some(Type::new(
                            t.name.clone(),
                            t.oid,
                            Kind::Simple,
                            "public".to_string(),
                        )),
                    };

                    return type_;
                };

                match name.as_str() {
                    "int4" => Some(Type::INT4),
                    "int8" => Some(Type::INT8),
                    "text" => Some(Type::TEXT),
                    "bool" => Some(Type::BOOL),
                    "float4" => Some(Type::FLOAT4),
                    "float8" => Some(Type::FLOAT8),
                    "numeric" => Some(Type::NUMERIC),
                    "date" => Some(Type::DATE),
                    "time" => Some(Type::TIME),
                    "timestamp" => Some(Type::TIMESTAMP),
                    "timestamptz" => Some(Type::TIMESTAMPTZ),
                    "interval" => Some(Type::INTERVAL),
                    "uuid" => Some(Type::UUID),
                    "json" => Some(Type::JSON),
                    "jsonb" => Some(Type::JSONB),
                    "bytea" => Some(Type::BYTEA),
                    "varchar" => Some(Type::VARCHAR),
                    "char" => Some(Type::CHAR),

                    n => Some(Type::new(
                        n.to_string(),
                        tn.type_oid,
                        Kind::Simple,
                        "pg_catalog".to_string(),
                    )),
                }
            }
            _ => None,
        }
    }

    pub fn get_column_type(&self, column: &Column) -> String {
        if let Some(name) = self.custom_types_by_oid.get(&column.type_oid) {
            match **name {
                CustomType::Composite(ref t) => t.name.clone(),
                CustomType::Enum(ref t) => t.name.clone(),
            }
        } else {
            column.type_name.clone()
        }
    }
}

pub fn type_to_string<'a>(type_: &'a Type) -> &'a str {
    type_.name()
}
