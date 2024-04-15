use std::iter::zip;

use crate::{
    code_builder::codegen_helper::CodegenHelper,
    loose_parser::{
        parse::ParserContext,
        parse_cf::{Expression, LR1Kind},
    },
    parser::parser,
    query::query::Query,
    utils::result::{PiquedError, Result},
    workspace::workspace::Workspace,
};

use tower_lsp::lsp_types::{
    Hover, HoverContents, LanguageString, MarkedString, MessageType, Position,
};

use super::{lsp::Backend, lsp_fmt::format_table_like};

impl Backend {
    pub async fn get_hover_data(
        &self,
        workspace: &Workspace,
        file_contents: &str,
        position: &Position,
    ) -> Result<Hover> {
        let parsed = parser::load_file(file_contents)?;
        let mut context = ParserContext::new(file_contents);
        let partial_parsed = context.parse();

        if let Err(e) = &workspace.query {
            self.client
                .log_message(MessageType::INFO, "Unable to connect to server")
                .await;

            return Err(e.clone());
        }

        let query_obj = workspace.query.as_ref().unwrap();

        let stack = partial_parsed.inspect(position);
        self.client
            .log_message(MessageType::INFO, format!("Stack: {:#?}", stack))
            .await;

        for stack_el in stack.unwrap_or(vec![]).iter() {
            if let Some(hov) = self.get_hover_data_for_kind(&query_obj, &stack_el.kind) {
                return Ok(hov);
            }
        }

        let statement = parsed
            .statements
            .iter()
            .enumerate()
            .find(|(_i, stmt)| &stmt.range.start < position && &stmt.range.end > position);

        if let None = statement {
            return Err(PiquedError::OtherError(
                "Could not parse statement".to_string(),
            ));
        }

        let (i, statement) = statement.unwrap();
        let prepared_statement =
            parser::get_prepared_statement(&statement, &parsed.tokens, &file_contents, || {
                format!("query_{i}", i = i)
            })?;

        self.client
            .log_message(MessageType::INFO, "Found prepared statement")
            .await;

        let probed_type = query_obj.probe_type(&prepared_statement).await?;

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

    fn get_hover_data_for_kind(&self, query: &Query, kind: &LR1Kind) -> Option<Hover> {
        let mut builder = CodegenHelper::new(&"  ", "\n");

        match kind {
            LR1Kind::Expression(exp) => {
                if let Expression::Identifier(table_name) = exp.as_ref() {
                    let table_data = query.tables.get(table_name)?;

                    builder.write_line(Some(&format!("{} (", table_name)));
                    builder.with_indent(|mut builder| {
                        format_table_like(&mut builder, table_data);
                    });
                    builder.write_line(Some(&")"));

                    Some(Hover {
                        contents: HoverContents::Array(vec![
                            MarkedString::LanguageString(LanguageString {
                                language: "pgsql".to_string(),
                                value: "(table)".to_string(),
                            }),
                            MarkedString::LanguageString(LanguageString {
                                language: "pgsql".to_string(),
                                value: builder.serialize(),
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
