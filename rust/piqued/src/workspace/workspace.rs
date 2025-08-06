use std::{collections::HashMap, path::PathBuf, sync::Arc};

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, Position, Range};

use crate::{
    codegen::{
        codegen::{CodeGenerationContext, CodeGenerationOptions},
        ts::schema::TSGenerator,
    },
    config::config::Config,
    parser::parser::{self, RelocatedStmt},
    query::query::Query,
    utils::result::{PiquedError, Result},
};

#[derive(Debug)]
pub struct Workspace {
    files: HashMap<String, String>,
    pub root_dir: PathBuf,
    pub config: Arc<Config>,
    pub query: Result<Query>,
}

impl Workspace {
    pub async fn new(config: Arc<Config>, root_dir: PathBuf) -> Self {
        let query = Query::new(config.clone()).await;

        Workspace {
            root_dir,
            config: config.clone(),
            files: HashMap::<String, String>::new(),
            query,
        }
    }

    pub fn contains_file(&self, path: &PathBuf) -> bool {
        let root = self.config.workspace.root.as_ref().unwrap();
        path.starts_with(root)
    }

    pub fn get_file(&self, path: &str) -> Option<&String> {
        self.files.get(path)
    }

    pub fn patch_file(&mut self, path: String, contents: String) {
        match self.files.entry(path) {
            std::collections::hash_map::Entry::Occupied(mut o) => {
                o.insert(contents);
            }
            std::collections::hash_map::Entry::Vacant(v) => {
                v.insert(contents);
            }
        };
    }

    pub async fn reload_config(&mut self, config: Arc<Config>) {
        self.config = config.clone();
        self.query = Query::new(config).await;
    }

    pub async fn diagnostics_for_statment(&self, stmt: &RelocatedStmt) -> Result<()> {
        let query = match &self.query {
            Err(e) => return Err(e.clone()),
            Ok(q) => q,
        };

        let _ = query.probe_type(&stmt).await?;

        Ok(())
    }

    pub async fn get_diagnostics(&self, path: &str) -> Result<Vec<Diagnostic>> {
        let file_contents = match self.files.get(path) {
            Some(data) => data,
            None => return Err(PiquedError::OtherError("File not found".to_string())),
        };

        let parsed = parser::load_file(file_contents)?;

        let mut diagnostics: Vec<Diagnostic> = Vec::new();
        for stmt in &parsed.statements {
            match self.diagnostics_for_statment(stmt).await {
                Ok(_) => {}
                Err(err) => {
                    let msg = match &err {
                        PiquedError::ParseErrorAt(e) => format!("Error parsing query at \"{e}\""),
                        PiquedError::PostgresError(e) => e.clone(),
                        PiquedError::OtherError(e) => format!("Error: {e}"),
                        PiquedError::SerdeParseError(e) => format!("Serde error: {e}"),
                    };

                    let range = match &err {
                        PiquedError::ParseErrorAt(_) => Range {
                            start: stmt.range.start,
                            end: Position {
                                line: stmt.range.start.line,
                                character: stmt.range.start.character + 2,
                            },
                        },
                        _ => stmt.range.clone(),
                    };

                    diagnostics.push(Diagnostic::new(
                        range,
                        Some(DiagnosticSeverity::ERROR),
                        None,
                        None,
                        msg,
                        None,
                        None,
                    ))
                }
            }
        }

        Ok(diagnostics)
    }

    pub async fn gen_code(&self, options: &CodeGenerationOptions) -> Result<()> {
        let query = match &self.query {
            Err(e) => return Err(e.clone()),
            Ok(q) => q,
        };

        let codegen = CodeGenerationContext::new(self.config.clone(), query);
        let ts_generator = TSGenerator::new();
        let mut success = true;

        success &= codegen.generate_system_types(&ts_generator, &options).await;
        success &= codegen.generate_table_file(&ts_generator, &options).await;
        success &= codegen.generate_queries(&ts_generator, &options).await;

        if !success {
            Err(PiquedError::OtherError(
                "Code generation failed".to_string(),
            ))
        } else {
            Ok(())
        }
    }

    pub async fn is_compile_target(&self, path: &PathBuf) -> bool {
        let ext = path.extension().unwrap();

        path.starts_with(&self.root_dir)
            && (ext == "sql" || ext == "psql" || ext == "pgsql" || ext == "pg")
    }
}
