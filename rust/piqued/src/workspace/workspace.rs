use std::{collections::HashMap, path::PathBuf};

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity};

use crate::{
    config::config::Config,
    parser::parser::{self, ParsedFile, RelocatedStmt},
    query::query::Query,
    utils::result::{PiquedError, Result},
};

#[derive(Debug)]
pub struct Workspace<'a> {
    root_dir: PathBuf,
    config: &'a Config,
    files: HashMap<&'a str, &'a str>,
    query: Result<Query<'a>>,
}

impl<'a> Workspace<'a> {
    pub async fn new(config: &'a Config, root_dir: PathBuf) -> Self {
        let query = Query::new(config).await;

        Workspace {
            root_dir,
            config,
            files: HashMap::<&'a str, &'a str>::new(),
            query,
        }
    }

    pub fn contains_file(&self, path: &PathBuf) -> bool {
        let root = self.config.workspace.root.as_ref().unwrap();
        path.starts_with(root)
    }

    pub fn patch_file(&mut self, path: &'a str, contents: &'a str) {
        self.files
            .entry(path)
            .and_modify(|e| *e = contents)
            .or_insert(contents);
    }

    pub async fn reload_config(&mut self, config: &'a Config) {
        self.config = config;
        self.query = Query::new(config).await;
    }

    pub async fn diagnostics_for_statment(
        &self,
        file_contents: &str,
        parsed: &ParsedFile,
        stmt: &RelocatedStmt,
    ) -> Result<()> {
        let query = match &self.query {
            Err(e) => return Err(e.clone()),
            Ok(q) => q,
        };

        let prepared_statement =
            parser::get_prepared_statement(&stmt, &parsed.tokens, &file_contents, || {
                "query".to_string()
            })?;

        let _ = query.probe_type(&prepared_statement).await?;

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
            match self
                .diagnostics_for_statment(file_contents, &parsed, stmt)
                .await
            {
                Ok(_) => {}
                Err(err) => {
                    let msg = match err {
                        PiquedError::ParseErrorAt(e) => format!("Error parsing query at \"{e}\""),
                        PiquedError::PostgresError(e) => e,
                        PiquedError::OtherError(e) => format!("Error: {e}"),
                        PiquedError::SerdeParseError(e) => format!("Error: {e}"),
                    };

                    diagnostics.push(Diagnostic::new(
                        stmt.range.clone(),
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
}
