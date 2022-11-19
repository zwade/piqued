use std::env::current_dir;

use serde_derive::Deserialize;
use tokio::fs;

#[derive(Debug, Eq, PartialEq, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    #[serde(default = "default_postgres_obj")]
    pub postgres: PostgresConfig,

    #[serde(default = "default_emit_obj")]
    pub emit: EmitConfig
}

#[derive(Debug, Eq, PartialEq, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PostgresConfig {
    #[serde(default = "default_postgres_uri")]
    pub uri: String,
    #[serde(default = "default_schema")]
    pub schema: String,
}

#[derive(Debug, Eq, PartialEq, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EmitConfig {
    #[serde(default = "default_type_file")]
    pub type_file: String
}

#[derive(Debug)]
pub enum ConfigError {
    IoError(std::io::Error),
    ParseError(toml::de::Error),
}

impl From<std::io::Error> for ConfigError {
    fn from(err: std::io::Error) -> Self {
        Self::IoError(err)
    }
}

impl From<toml::de::Error> for ConfigError {
    fn from(err: toml::de::Error) -> Self {
        Self::ParseError(err)
    }
}

fn default_postgres_uri() -> String {
    "postgresql://postgres:@localhost:5432/postgres".to_string()
}

fn default_schema() -> String {
    "public".to_string()
}

fn default_type_file() -> String {
    "./postgres".to_string()
}

fn default_postgres_obj() -> PostgresConfig {
    PostgresConfig {
        uri: default_postgres_uri(),
        schema: default_schema(),
    }
}

fn default_emit_obj() -> EmitConfig {
    EmitConfig {
        type_file: default_type_file(),
    }
}

impl Config {
    pub async fn load(path_override: Option<&str>) -> Result<Self, ConfigError> {
        let path = match path_override {
            Some(path) => path.to_string(),
            None => {
                let path_buf = current_dir()?.join(".piqued.toml");
                path_buf.to_str().unwrap().to_string()
            }
        };

        let config: Self =
            match fs::read_to_string(path).await {
                Ok(data) => {
                    toml::from_str(&data)?
                },
                Err(_) => {
                    toml::from_str("")?
                }
            };

        Ok(config)
    }
}
