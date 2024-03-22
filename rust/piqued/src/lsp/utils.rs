use std::iter::zip;

use crate::{
    code_builder::code_builder::CodeBuilder,
    loose_parser::{
        parse::ParserContext,
        parse_cf::{Expression, LR1Kind},
    },
    parser::parser::{self, ParsedFile, RelocatedStmt},
    utils::result::{PiquedError, Result},
};

use tower_lsp::lsp_types::{
    Diagnostic, DiagnosticSeverity, Hover, HoverContents, LanguageString, MarkedString,
    MessageType, Position,
};

use super::{lsp::Backend, lsp_fmt::format_table_like};

impl Backend {
    pub async fn diagnostics_for_statment(
        &self,
        file_contents: &String,
        parsed: &ParsedFile,
        stmt: &RelocatedStmt,
    ) -> Result<()> {
        let prepared_statement =
            parser::get_prepared_statement(&stmt, &parsed.tokens, &file_contents, || {
                "query".to_string()
            })?;
        let _ = self.query.probe_type(&prepared_statement).await?;

        Ok(())
    }

    pub async fn get_diagnostics(&self, file_data: Option<&String>) -> Result<Vec<Diagnostic>> {
        if file_data.is_none() {
            return Err(PiquedError::OtherError("Something went wrong".to_string()));
        }

        let file_contents = file_data.unwrap();
        let parsed = parser::load_file(&file_contents)?;

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

    pub async fn get_hover_data(
        &self,
        file_data: Option<&String>,
        position: &Position,
    ) -> Result<Hover> {
        match file_data {
            None => Err(PiquedError::OtherError("File not found".to_string())),
            Some(file_contents) => {
                let parsed = parser::load_file(file_contents)?;
                let mut context = ParserContext::new(file_contents);
                let partial_parsed = context.parse();

                let stack = partial_parsed.inspect(position);
                self.client
                    .log_message(MessageType::INFO, format!("Stack: {:#?}", stack))
                    .await;

                for stack_el in stack.unwrap_or(vec![]).iter() {
                    if let Some(hov) = self.get_hover_data_for_kind(&stack_el.kind) {
                        return Ok(hov);
                    }
                }

                let statement =
                    parsed.statements.iter().enumerate().find(|(_i, stmt)| {
                        &stmt.range.start < position && &stmt.range.end > position
                    });

                if let None = statement {
                    return Err(PiquedError::OtherError(
                        "Could not parse statement".to_string(),
                    ));
                }

                let (i, statement) = statement.unwrap();
                let prepared_statement = parser::get_prepared_statement(
                    &statement,
                    &parsed.tokens,
                    &file_contents,
                    || format!("query_{i}", i = i),
                )?;

                self.client
                    .log_message(MessageType::INFO, "Found prepared statement")
                    .await;

                let probed_type = self.query.probe_type(&prepared_statement).await?;

                self.client
                    .log_message(
                        MessageType::INFO,
                        format!("Finished probing type:\n{:#?}", probed_type),
                    )
                    .await;

                let mut arg_string_vec: Vec<String> = vec![];
                for (i, arg) in probed_type.args.iter().enumerate() {
                    match &prepared_statement.details.params {
                        Some(params) if params.len() > i => {
                            arg_string_vec.push(format!("{} {}", params[i], arg))
                        }
                        _ => arg_string_vec.push(format!("${} {}", i + 1, arg.clone())),
                    };
                }

                let mut col_string_vec = vec![];
                for (name, typ) in zip(&probed_type.column_names, &probed_type.column_types) {
                    col_string_vec.push(format!("    {} {}", name, typ));
                }

                let header = format!("(query) {}", prepared_statement.details.name);
                let response_str = format!(
                    "({}) => (\n{}\n)\n",
                    arg_string_vec.join(", "),
                    col_string_vec.join("\n")
                );

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
                    range: None,
                })
            }
        }
    }

    fn get_hover_data_for_kind(&self, kind: &LR1Kind) -> Option<Hover> {
        let mut builder = CodeBuilder::new();

        match kind {
            LR1Kind::Expression(exp) => {
                if let Expression::Identifier(table_name) = exp.as_ref() {
                    let table_data = self.query.tables.get(table_name)?;

                    builder.writeln(format!("{} (", table_name));
                    builder.indent();
                    format_table_like(&mut builder, table_data);
                    builder.unindent();
                    builder.writeln(")".to_string());

                    Some(Hover {
                        contents: HoverContents::Array(vec![
                            MarkedString::LanguageString(LanguageString {
                                language: "pgsql".to_string(),
                                value: "(table)".to_string(),
                            }),
                            MarkedString::LanguageString(LanguageString {
                                language: "pgsql".to_string(),
                                value: builder.string(),
                            }),
                        ]),
                        range: None,
                    })
                } else {
                    None
                }
            }

            _ => None,
        }
    }
}
