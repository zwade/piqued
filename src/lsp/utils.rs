use std::iter::zip;

use tower_lsp::lsp_types::{Position, Hover, MessageType, HoverContents, MarkedString, LanguageString, Diagnostic, DiagnosticSeverity};
use crate::parser::parser::{Result, PiquedError, self, RelocatedStmt, ParsedFile};

use super::lsp::Backend;

pub async fn diagnostics_for_statment(
    backend: &Backend,
    file_contents: &String,
    parsed: &ParsedFile,
    stmt: &RelocatedStmt,
) -> Result<()> {
    let prepared_statement = parser::get_prepared_statement(stmt.clone(), &parsed.tokens, &file_contents)?;
    let _ = backend.query.probe_type(&prepared_statement).await?;

    Ok(())
}

pub async fn get_diagnostics(
    backend: &Backend,
    file_data: Option<&String>,
) -> Result<Vec<Diagnostic>> {
    if file_data.is_none() {
        return Err(PiquedError::OtherError("Somethign went wrong".to_string()));
    }

    let file_contents = file_data.unwrap();
    let parsed = parser::load_file(&file_contents)?;

    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    for stmt in &parsed.statements {
        match diagnostics_for_statment(backend, file_contents, &parsed, stmt).await {
            Ok(_) => {},
            Err(err) => {
                let msg =
                    match err {
                        PiquedError::ParseErrorAt(e) => format!("Error parsing query at \"{e}\""),
                        PiquedError::PostgresError(e) => e,
                        PiquedError::OtherError(e) => format!("Error: {e}"),
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

pub async fn get_hover_data(
    backend: &Backend,
    file_data: Option<&String>,
    position: &Position
) -> Result<Hover> {
    match file_data {
        None => Err(PiquedError::OtherError("File not found".to_string())),
        Some(file_contents) => {
            let parsed = parser::load_file(file_contents)?;

            let statement = parsed.statements.iter().find(|stmt| {
                &stmt.range.start < position && &stmt.range.end > position
            });

            backend.client.log_message(MessageType::INFO, format!("File: {:#?}", &file_contents)).await;

            if let None = statement {
                return Err(PiquedError::OtherError("Could not parse statement".to_string()));
            }

            let statement = statement.unwrap();
            let prepared_statement = parser::get_prepared_statement(statement.clone(), &parsed.tokens, &file_contents)?;

            backend.client.log_message(MessageType::INFO, "Found prepared statement").await;

            let probed_type = backend.query.probe_type(&prepared_statement).await?;

            backend.client.log_message(MessageType::INFO, "Finished probing type").await;

            let mut arg_string_vec: Vec<String> = vec![];
            let mut i = 1;
            for arg in &probed_type.args {
                arg_string_vec.push(format!("${} {}", &i, arg.clone()));
                i += 1;
            }

            let mut col_string_vec = vec![];
            for (name, typ) in zip(&probed_type.column_names, &probed_type.column_types) {
                col_string_vec.push(format!("    {} {}", name, typ));
            }

            let header = format!(
                "(query) {}",
                prepared_statement
                    .details
                    .name
                    .map_or_else(|| "anonymous".to_string(), |name| name)
            );
            let response_str = format!("({}) => (\n{}\n)\n", arg_string_vec.join(", "), col_string_vec.join("\n"));

            Ok(Hover {
                contents: HoverContents::Array(vec![
                    MarkedString::LanguageString(LanguageString {
                        language: "pgsql".to_string(),
                        value: header,
                    }),
                    MarkedString::LanguageString(LanguageString {
                        language: "pgsql".to_string(),
                        value: response_str,
                    }),
                    MarkedString::String(prepared_statement.details.comment),
                ]),
                range: None
            })
        }

    }
}