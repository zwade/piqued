use std::{collections::HashSet, iter::zip, sync::Arc};

use crate::{
    loose_parser::{
        parse::{BestGuessContextKind, LateralContext, ParserContext},
        parse_cf::{Expression, FromExpression, LR1Kind, LR1State, TableLike},
    },
    parser::parser,
    utils::result::{PiquedError, Result},
    workspace::workspace::Workspace,
};

use tower_lsp::lsp_types::{
    CompletionItem, CompletionItemKind, CompletionResponse, Hover, HoverContents, LanguageString,
    MarkedString, MessageType, Position,
};

use super::{
    formatters::{format_column, format_table},
    lsp::Backend,
};

#[derive(Debug, Eq, PartialEq, Clone)]
pub struct PointContext {
    pub scoped_tables: HashSet<Arc<FromExpression>>,
    pub lateral_ctx: LateralContext,
}

impl PointContext {
    pub fn merge_tables(&mut self, tables: &Vec<Arc<FromExpression>>) {
        for from_expr in tables {
            self.scoped_tables.insert(from_expr.clone());
        }
    }
}

impl Backend {
    fn find_context_at_position(
        &self,
        file_contents: &str,
        position: &Position,
    ) -> (Option<Vec<Arc<LR1State>>>, PointContext) {
        let mut context = ParserContext::new(file_contents);
        let partial_parsed = context.parse();

        let stack = partial_parsed.inspect(position);
        let lateral_ctx = partial_parsed.get_context_kind(position);

        let ctx = PointContext {
            lateral_ctx,
            scoped_tables: HashSet::new(),
        };

        return (stack, ctx);
    }

    fn descend<F, T>(
        &self,
        stack: &Option<Vec<Arc<LR1State>>>,
        ctx: &mut PointContext,
        descender: F,
    ) -> Option<T>
    where
        F: Fn(&LR1State, &PointContext) -> Option<T>,
    {
        for stack_el in stack.as_ref()?.iter().rev() {
            match &stack_el.kind {
                LR1Kind::SelectQuery(q) => {
                    if let Some(from_tables) = &q.from {
                        ctx.merge_tables(from_tables);
                    }

                    let mut joins = vec![];
                    for join in &q.joins {
                        joins.push(join.from.clone());
                    }

                    ctx.merge_tables(&joins);
                }
                _ => {}
            }

            if let Some(res) = descender(stack_el, &ctx) {
                return Some(res);
            }
        }

        None
    }

    fn get_hover_data_for_kind(
        &self,
        workspace: &Workspace,
        kind: &LR1Kind,
        ctx: &PointContext,
    ) -> Option<Result<Hover>> {
        let query = workspace.query.as_ref().unwrap();

        match (kind, &ctx.lateral_ctx.kind) {
            (LR1Kind::TableLike(exp), BestGuessContextKind::TableExpression) => {
                let TableLike::Table(id) = exp.as_ref();
                let lowercased = id.to_lowercase();
                let table_data = query.tables.get(&lowercased)?;
                Some(Ok(format_table(workspace, id, table_data)))
            }

            (LR1Kind::Expression(exp), BestGuessContextKind::ColumnExpression) => {
                if let Expression::Identifier(id) = exp.as_ref() {
                    for table in &ctx.scoped_tables {
                        match *table.table {
                            TableLike::Table(ref table_name) => {
                                let table_data = query.tables.get(table_name)?;

                                if let Some(ref alias) = table.alias {
                                    if *alias.to_lowercase() == id.to_lowercase() {
                                        return Some(Ok(format_table(
                                            workspace, table_name, table_data,
                                        )));
                                    }
                                } else if *table_name == id.to_lowercase() {
                                    return Some(Ok(format_table(
                                        workspace, table_name, table_data,
                                    )));
                                }

                                if let Some(column) =
                                    table_data.into_iter().find(|c| c.name == id.to_lowercase())
                                {
                                    return Some(Ok(format_column(workspace, table_name, column)));
                                }
                            }
                        }
                    }
                }

                None
            }

            _ => None,
        }
    }

    pub async fn get_hover_data(
        &self,
        workspace: &Workspace,
        file_contents: &str,
        position: &Position,
    ) -> Result<Hover> {
        let parsed = parser::load_file(file_contents)?;
        let query_obj = workspace.query.as_ref()?;

        let (stack, mut ctx) = self.find_context_at_position(file_contents, position);

        if let Some(res) = self.descend(&stack, &mut ctx, |state, ctx| {
            self.get_hover_data_for_kind(workspace, &state.kind, ctx)
        }) {
            return res;
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

    pub async fn get_completion_data(
        &self,
        workspace: &Workspace,
        file_contents: &str,
        position: &Position,
    ) -> Result<CompletionResponse> {
        let mut context = ParserContext::new(file_contents);
        let partial_parsed = context.parse();
        self.client
            .log_message(MessageType::INFO, format!("Context: {:#?}", partial_parsed))
            .await;

        let query_obj = workspace.query.as_ref()?;

        let (stack, mut ctx) = self.find_context_at_position(file_contents, position);
        self.descend(&stack, &mut ctx, |_a, _b| None::<Option<()>>); // Doing this for effect (merging in all from-tables)

        self.client
            .log_message(MessageType::INFO, format!("{:#?}", ctx))
            .await;

        match &ctx.lateral_ctx.kind {
            BestGuessContextKind::TableExpression => {
                let result = query_obj
                    .tables
                    .keys()
                    .into_iter()
                    .map(|table_name| CompletionItem {
                        label: table_name.clone(),
                        kind: Some(CompletionItemKind::CLASS),
                        ..Default::default()
                    })
                    .collect();

                Ok(CompletionResponse::Array(result))
            }
            BestGuessContextKind::ColumnExpression => {
                let mut result = vec![];

                // TODO(zwade): Abstract (and cache?) this stuff
                let should_scope = ctx.scoped_tables.len() > 1;

                for table in &ctx.scoped_tables {
                    match table.table.as_ref() {
                        TableLike::Table(table_name) => {
                            if let Some(ref alias) = table.alias {
                                result.push(CompletionItem {
                                    label: alias.clone(),
                                    detail: Some(table_name.clone()),
                                    kind: Some(CompletionItemKind::CLASS),
                                    ..Default::default()
                                });
                            } else {
                                result.push(CompletionItem {
                                    label: table_name.clone(),
                                    kind: Some(CompletionItemKind::CLASS),
                                    ..Default::default()
                                });
                            }
                        }
                    }
                }

                for table in &ctx.scoped_tables {
                    match table.table.as_ref() {
                        TableLike::Table(table_name) => {
                            if let Some(table_data) = query_obj.tables.get(table_name) {
                                for column in table_data {
                                    let label = if should_scope {
                                        format!("{:}.{:}", table.effective_name(), column.name)
                                    } else {
                                        column.name.clone()
                                    };

                                    result.push(CompletionItem {
                                        label,
                                        kind: Some(CompletionItemKind::FIELD),
                                        detail: Some(table_name.clone()),
                                        ..Default::default()
                                    });
                                }
                            }
                        }
                    }
                }

                Ok(CompletionResponse::Array(result))
            }
            _ => Ok(CompletionResponse::Array(vec![])),
        }
    }
}
