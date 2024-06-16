use std::path::PathBuf;

use crate::utils::result::Result;
use serde_derive::Deserialize;

#[derive(Debug, Eq, PartialEq, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    #[serde(default = "default_postgres_obj")]
    pub postgres: PostgresConfig,
    #[serde(default = "default_emit_obj")]
    pub emit: EmitConfig,
    pub workspace: ConfigWorkspace,
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
    pub type_file: String,
    #[serde(default = "default_module_type")]
    pub module_type: String,
    #[serde(default)]
    pub table_file: Option<String>,
}

#[derive(Debug, Eq, PartialEq, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigWorkspace {
    pub root: Option<PathBuf>,
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
        module_type: default_module_type().to_string(),
        table_file: None,
    }
}

fn default_module_type() -> String {
    "CommonJS".to_string()
}

impl Config {
    pub async fn find_dir(dir: &PathBuf) -> Option<PathBuf> {
        let mut file_buf = dir.to_path_buf();
        file_buf.push("piqued.toml");

        Config::find_file(&file_buf).await
    }

    pub async fn find_file(file: &PathBuf) -> Option<PathBuf> {
        let mut file_buf = file.to_path_buf();
        let file_name = file_buf.file_name().unwrap().to_str().unwrap().to_string();

        loop {
            if !file_buf.pop() {
                break None;
            }

            let file = &file_buf.join(&file_name);
            let exists = tokio::fs::try_exists(file).await.unwrap_or(false);

            if exists {
                break Some(file.clone());
            }
        }
    }

    pub async fn load(file: &Option<PathBuf>, working_dir: &PathBuf) -> Result<Self> {
        let mut ruulang_config: Config = if let Some(path) = file {
            let contents = tokio::fs::read(path).await?;
            let str_contents = std::str::from_utf8(contents.as_slice()).unwrap();
            toml::from_str(str_contents)?
        } else {
            toml::from_str("")?
        };

        if ruulang_config.workspace.root.is_none() {
            ruulang_config.workspace.root = Some(working_dir.clone());
        }

        if let Some(root) = &ruulang_config.workspace.root {
            let root = root.clone();
            let root = root.canonicalize()?;
            ruulang_config.workspace.root = Some(root);
        }

        Ok(ruulang_config)
    }
}
