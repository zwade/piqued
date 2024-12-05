use std::sync::Arc;

use pg_query::protobuf::KeywordKind;
use sqlparser::{
    dialect::PostgreSqlDialect,
    keywords::Keyword,
    tokenizer::{Token, Tokenizer, Word},
};
use tower_lsp::lsp_types::Position;

use super::parse_cf::{
    BinopExpression, ColumnExpression, Expression, FromExpression, JoinExpression, JoinKind,
    LR1Kind, LR1State, Operator, ParseCF, SelectQuery, TableLike, UnopExpression,
};

pub struct ParserContext {
    tokens: Vec<Token>,

    next_token: usize,
    stack: Vec<Arc<LR1State>>,
    cleanup_stack: Vec<Arc<LR1State>>,
    has_cleaned_up: bool,
    source: String,
}

impl ParserContext {
    pub fn new(sql: &str) -> Self {
        let dialect = PostgreSqlDialect {};
        let tokens = Tokenizer::new(&dialect, sql).tokenize().unwrap();

        ParserContext {
            tokens,
            next_token: 0,
            stack: vec![],
            cleanup_stack: vec![],
            source: sql.to_string(),
            has_cleaned_up: false,
        }
    }

    pub fn parse<'a>(&'a mut self) -> ParserResult<'a> {
        loop {
            let result = self.iterate_once();
            match result {
                ParseCF::NotApplicable => {
                    if self.next_token < self.tokens.len() {
                        self.next_token += 1;
                        continue;
                    }

                    if !self.has_cleaned_up {
                        // If we've hit the end, there's nothing else to do, so we begin a best effort cleanup process
                        self.cleanup_dangling_tokens();
                        self.has_cleaned_up = true;

                        continue;
                    }

                    if self.cleanup_stack.len() == 0 {
                        break;
                    }

                    self.stack.push(self.cleanup_stack.pop().unwrap());
                    continue;
                }
                ParseCF::Shifted(shifted) => {
                    self.stack.push(Arc::new(LR1State {
                        start: self.next_token as u32,
                        end: self.next_token as u32 + 1,
                        kind: shifted,
                        children: vec![],
                    }));

                    self.next_token += 1;
                }
                ParseCF::Reduced((used_count, new_state_kind)) => {
                    let (prefix, suffix) =
                        self.stack.split_at(self.stack.len() - used_count as usize);

                    let start = suffix
                        .iter()
                        .fold(u32::MAX, |acc, state| acc.min(state.start));
                    let end = suffix
                        .iter()
                        .fold(u32::MIN, |acc, state| acc.max(state.end));

                    let children = suffix.iter().map(|state| Arc::clone(state)).collect();

                    let new_state = LR1State {
                        start,
                        end,
                        kind: new_state_kind,
                        children,
                    };

                    self.stack = prefix.to_vec();
                    self.stack.push(Arc::new(new_state));
                }
                ParseCF::ReduceWhitespace => {
                    if self.stack.len() < 1 {
                        self.next_token += 1;
                        continue;
                    }

                    let (prefix, suffix) = self.stack.split_at(self.stack.len() - 1 as usize);
                    let to_update = suffix.get(0).unwrap();

                    let new_state = LR1State {
                        start: to_update.start,
                        end: to_update.end + 1,
                        kind: to_update.kind.clone(),
                        children: to_update.children.clone(),
                    };

                    self.stack = prefix.to_vec();
                    self.stack.push(Arc::new(new_state));
                    self.next_token += 1;
                }
            }
        }

        ParserResult::new(&self.tokens, &self.source, self.stack.clone())
    }

    fn iterate_once(&mut self) -> ParseCF {
        let current_stack = self
            .stack
            .iter()
            .map(|v| v.kind.to_name())
            .collect::<Vec<_>>()
            .join(",");

        // println!("Stack: {:}", current_stack);

        let tok = self.tokens.get(self.next_token).unwrap_or(&Token::EOF);

        self.reduce_expression_1(tok)?;
        self.reduce_operators(tok)?;
        self.reduce_wildcard(tok)?;

        self.shift_operators(tok)?;
        self.shift_whitespace(tok)?;

        self.reduce_join_kind(tok)?;
        self.reduce_select_stmt(tok)?;
        self.reduce_from_stmt(tok)?;
        self.reduce_join_stmt(tok)?;
        self.reduce_select_query(tok)?;

        // List reductions are low priority
        self.reduce_from_expression_list(tok)?;
        self.reduce_expression_list(tok)?;

        // Next, if we have nothing better to do with a word
        // We treat it as an identifier
        self.reduce_identifier(tok)?;

        // Finally shift in whatever's next
        self.shift_keyword(tok)?;

        if *tok != Token::EOF {
            return ParseCF::Shifted(LR1Kind::Token(tok.clone()));
        }

        ParseCF::NotApplicable
    }

    fn cleanup_dangling_tokens(&mut self) -> () {
        let mut acc: Vec<Arc<LR1State>> = vec![];
        self.stack.iter().for_each(|state| {
            // This is terribly thrashy
            if let Some(current) = acc.pop() {
                // If the last statement was terminal, we don't want to do any reductions
                let current_last_token = &self.tokens[(current.end) as usize];
                if let Token::SemiColon = current_last_token {
                    acc.push(current);
                    acc.push(state.clone());

                    return;
                }

                match (&current.kind, &state.kind) {
                    (LR1Kind::Token(_), _) => {
                        acc.push(current);
                        acc.push(state.clone());
                    }
                    (_, LR1Kind::Token(_)) => {
                        acc.push(Arc::new(LR1State {
                            start: current.start,
                            end: state.end,
                            kind: current.kind.clone(),
                            children: vec![current.clone(), state.clone()],
                        }));
                    }
                    _ => {
                        acc.push(current);
                        acc.push(state.clone());
                    }
                }
            } else {
                acc.push(state.clone());
            };
        });

        acc.reverse();
        self.stack = vec![];
        self.cleanup_stack = acc;
    }

    fn shift_whitespace(&self, tok: &Token) -> ParseCF {
        match tok {
            Token::Whitespace(_) => ParseCF::ReduceWhitespace,
            Token::SemiColon => ParseCF::ReduceWhitespace,
            _ => ParseCF::NotApplicable,
        }
    }

    fn shift_keyword(&self, tok: &Token) -> ParseCF {
        match tok {
            Token::Word(Word {
                keyword: Keyword::SELECT | Keyword::FROM,
                ..
            }) => ParseCF::Shifted(LR1Kind::Token(tok.clone())),

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_identifier(&self, _tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match &first.kind {
            LR1Kind::Token(Token::Word(Word {
                keyword: Keyword::NoKeyword,
                value,
                ..
            })) => ParseCF::Reduced((
                1,
                LR1Kind::Expression(Arc::new(Expression::Identifier(value.clone()))),
            )),

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_expression_1(&self, _tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match &first.kind {
            LR1Kind::Token(Token::SingleQuotedString(string)) => ParseCF::Reduced((
                1,
                LR1Kind::Expression(Arc::new(Expression::StringLiteral(string.clone()))),
            )),

            LR1Kind::Token(Token::HexStringLiteral(string)) => ParseCF::Reduced((
                1,
                LR1Kind::Expression(Arc::new(Expression::StringLiteral(string.clone()))),
            )),

            LR1Kind::Token(Token::EscapedStringLiteral(string)) => ParseCF::Reduced((
                1,
                LR1Kind::Expression(Arc::new(Expression::StringLiteral(string.clone()))),
            )),

            LR1Kind::Token(Token::NationalStringLiteral(string)) => ParseCF::Reduced((
                1,
                LR1Kind::Expression(Arc::new(Expression::StringLiteral(string.clone()))),
            )),

            LR1Kind::Token(Token::Number(number, _)) => ParseCF::Reduced((
                1,
                LR1Kind::Expression(Arc::new(Expression::NumberLiteral(number.clone()))),
            )),

            LR1Kind::Token(Token::Word(Word {
                keyword: Keyword::NULL,
                ..
            })) => ParseCF::Reduced((1, LR1Kind::Expression(Arc::new(Expression::NullLiteral)))),

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_binop(&self, _tok: &Token) -> ParseCF {
        let (_third, second, first) = self.get_3_opt();

        let preceding_token = second.map(|state| state.kind.clone());
        let binop = match &first?.kind {
            LR1Kind::Token(op) => Operator::binop_from_token(op)?,
            _ => None?,
        };

        match (preceding_token, binop) {
            (Some(LR1Kind::Expression(_)), binop) => {
                ParseCF::Reduced((1, LR1Kind::Operator(binop)))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_unop(&self, _tok: &Token) -> ParseCF {
        let first = self.get_1()?;
        let unop = match &first.kind {
            LR1Kind::Token(op) => Operator::unop_from_token(op)?,
            _ => None?,
        };

        ParseCF::Reduced((1, LR1Kind::Operator(unop)))
    }

    fn reduce_binop_expression(&self, tok: &Token) -> ParseCF {
        let (third, second, first) = self.get_3()?;
        let upcoming_precedence = Operator::precedence_from_token(tok).map_or(255, |p| p);

        match (&third.kind, &second.kind, &first.kind) {
            (
                LR1Kind::Expression(left),
                LR1Kind::Operator(Operator::Binop(binop)),
                LR1Kind::Expression(right),
            ) => {
                let current_precedence = binop.precedence;
                if current_precedence > upcoming_precedence {
                    ParseCF::NotApplicable
                } else {
                    ParseCF::Reduced((
                        3,
                        LR1Kind::Expression(Arc::new(Expression::BinopExpression(
                            BinopExpression {
                                left: left.clone(),
                                right: right.clone(),
                                operator: binop.clone(),
                            },
                        ))),
                    ))
                }
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_unop_expression(&self, tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;
        let upcoming_precedence = Operator::precedence_from_token(tok).map_or(127, |p| p);

        match (&second.kind, &first.kind) {
            (LR1Kind::Operator(Operator::Unop(unop)), LR1Kind::Expression(expr)) => {
                let current_precedence = unop.precedence;
                if current_precedence > upcoming_precedence {
                    ParseCF::NotApplicable
                } else {
                    ParseCF::Reduced((
                        2,
                        LR1Kind::Expression(Arc::new(Expression::UnopExpression(UnopExpression {
                            expression: expr.clone(),
                            operator: unop.clone(),
                        }))),
                    ))
                }
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_operators(&self, tok: &Token) -> ParseCF {
        self.reduce_binop(tok)?;
        self.reduce_unop(tok)?;
        self.reduce_binop_expression(tok)?;
        self.reduce_unop_expression(tok)?;

        ParseCF::NotApplicable
    }

    fn reduce_wildcard(&self, _tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        match (&second.kind, &first.kind) {
            (LR1Kind::Expression(_), LR1Kind::Token(Token::Mul)) => ParseCF::NotApplicable,

            (_, LR1Kind::Token(Token::Mul)) => ParseCF::Reduced((
                1,
                LR1Kind::Expression(Arc::new(Expression::WildcardLiteral)),
            )),

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_column_expression_1(&self, _tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match &first.kind {
            LR1Kind::Expression(e) => {
                let column_expression = ColumnExpression::Unnamed(e.clone());
                ParseCF::Reduced((1, LR1Kind::ColumnExpression(Arc::new(column_expression))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_column_expression_2(&self, _tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        match (&second.kind, &first.kind) {
            (
                LR1Kind::Expression(e),
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::NoKeyword,
                    value,
                    ..
                })),
            ) => {
                let column_expression = ColumnExpression::Named(value.clone(), e.clone());
                ParseCF::Reduced((2, LR1Kind::ColumnExpression(Arc::new(column_expression))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_column_expression_3(&self, _tok: &Token) -> ParseCF {
        let (third, second, first) = self.get_3()?;

        match (&third.kind, &second.kind, &first.kind) {
            (
                LR1Kind::Expression(e),
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::AS,
                    ..
                })),
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::NoKeyword,
                    value: name,
                    ..
                })),
            ) => {
                let column_expression = ColumnExpression::Named(name.clone(), e.clone());
                ParseCF::Reduced((3, LR1Kind::ColumnExpression(Arc::new(column_expression))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_column_expression(&self, tok: &Token) -> ParseCF {
        // Don't attempt to reduce any lists if we have an upcoming `AS` (or name without AS)
        if let Token::Word(Word {
            keyword: Keyword::AS,
            ..
        }) = tok
        {
            return ParseCF::NotApplicable;
        }

        if let Token::Word(Word {
            keyword: Keyword::NoKeyword,
            ..
        }) = tok
        {
            return ParseCF::NotApplicable;
        }

        self.reduce_column_expression_3(tok)?;
        self.reduce_column_expression_2(tok)?;
        self.reduce_column_expression_1(tok)
    }

    fn reduce_expression_list_2(&self, _tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        match (&second.kind, &first.kind) {
            (LR1Kind::ExpressionList(exp), LR1Kind::ColumnExpression(e2)) => {
                let mut new_list = exp.clone();
                new_list.push(e2.clone());
                ParseCF::Reduced((2, LR1Kind::ExpressionList(new_list)))
            }
            (LR1Kind::ColumnExpression(e), LR1Kind::Token(Token::Comma)) => {
                ParseCF::Reduced((2, LR1Kind::ExpressionList(vec![e.clone()])))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_expression_list_1(&self, tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match (&first.kind, tok) {
            (LR1Kind::ColumnExpression(e), tok) if token_is_select_clause_boundary(tok) => {
                ParseCF::Reduced((1, LR1Kind::ExpressionList(vec![e.clone()])))
            }
            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_expression_list(&self, tok: &Token) -> ParseCF {
        self.reduce_column_expression(tok)?;

        self.reduce_expression_list_2(tok)?;
        self.reduce_expression_list_1(tok)?;
        ParseCF::NotApplicable
    }

    fn reduce_table_like_2(&self, _tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        match (&second.kind, &first.kind) {
            (
                // We have two conditions against which we can start
                // adding from tables.
                // Either we've found a raw "FROM" token
                // Or we've begun reducing an "XYZ JOIN" clause.
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::FROM,
                    ..
                }))
                | LR1Kind::JoinKind(_),
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::NoKeyword,
                    value,
                    ..
                })),
            ) => {
                let table_like = TableLike::Table(value.clone());
                ParseCF::Reduced((1, LR1Kind::TableLike(Arc::new(table_like))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_table_like_3(&self, _tok: &Token) -> ParseCF {
        let (third, second, first) = self.get_3()?;

        match (&third.kind, &second.kind, &first.kind) {
            (
                LR1Kind::FromExpressionList(_),
                LR1Kind::Token(Token::Comma),
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::NoKeyword,
                    value,
                    ..
                })),
            ) => {
                let table_like = TableLike::Table(value.clone());
                ParseCF::Reduced((1, LR1Kind::TableLike(Arc::new(table_like))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_from_expression_1(&self, _tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match &first.kind {
            LR1Kind::TableLike(table_like) => {
                let from_expression = FromExpression {
                    table: table_like.clone(),
                    alias: None,
                };
                ParseCF::Reduced((1, LR1Kind::FromExpression(Arc::new(from_expression))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_from_expression_2(&self, _tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        match (&second.kind, &first.kind) {
            (
                LR1Kind::TableLike(table_like),
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::NoKeyword,
                    value: alias,
                    ..
                })),
            ) => {
                let from_expression = FromExpression {
                    table: table_like.clone(),
                    alias: Some(alias.clone()),
                };
                ParseCF::Reduced((2, LR1Kind::FromExpression(Arc::new(from_expression))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_from_expression_3(&self, _tok: &Token) -> ParseCF {
        let (third, second, first) = self.get_3()?;

        match (&third.kind, &second.kind, &first.kind) {
            (
                LR1Kind::TableLike(table_like),
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::AS,
                    ..
                })),
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::NoKeyword,
                    value: alias,
                    ..
                })),
            ) => {
                let from_expression = FromExpression {
                    table: table_like.clone(),
                    alias: Some(alias.clone()),
                };
                ParseCF::Reduced((3, LR1Kind::FromExpression(Arc::new(from_expression))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_from_expression_list_1(&self, _tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match &first.kind {
            LR1Kind::FromExpression(e) => {
                ParseCF::Reduced((1, LR1Kind::FromExpressionList(vec![e.clone()])))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_from_expression_list_3(&self, _tok: &Token) -> ParseCF {
        let (third, second, first) = self.get_3()?;

        match (&third.kind, &second.kind, &first.kind) {
            (
                LR1Kind::FromExpressionList(exp),
                LR1Kind::Token(Token::Comma),
                LR1Kind::FromExpression(e2),
            ) => {
                let mut new_list = exp.clone();
                new_list.push(e2.clone());
                ParseCF::Reduced((3, LR1Kind::FromExpressionList(new_list)))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_from_expression_list(&self, tok: &Token) -> ParseCF {
        self.reduce_table_like_2(tok)?;
        self.reduce_table_like_3(tok)?;

        // Don't attempt to reduce any lists if we have an upcoming `AS` (or name without AS)
        if let Token::Word(Word {
            keyword: Keyword::AS,
            ..
        }) = tok
        {
            return ParseCF::NotApplicable;
        }

        if let Token::Word(Word {
            keyword: Keyword::NoKeyword,
            ..
        }) = tok
        {
            return ParseCF::NotApplicable;
        }

        self.reduce_from_expression_3(tok)?;
        self.reduce_from_expression_2(tok)?;
        self.reduce_from_expression_1(tok)?;
        self.reduce_from_expression_list_3(tok)?;
        self.reduce_from_expression_list_1(tok)?;

        ParseCF::NotApplicable
    }

    fn shift_operators(&self, tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        if let Some(op) = Operator::binop_from_token(tok) {
            // This is weird, we do a bit of "lexer hack"ing here
            // We only want to shift in a binop if there's an expression to the left.
            // Otherwise, we want to shift it as a unop
            if let LR1Kind::Expression(_) = first.kind {
                return ParseCF::Shifted(LR1Kind::Operator(op));
            }
        }

        if let Some(op) = Operator::unop_from_token(tok) {
            return ParseCF::Shifted(LR1Kind::Operator(op));
        }

        ParseCF::NotApplicable
    }

    fn reduce_select_stmt_2(&self, tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        if *tok == Token::Comma {
            return ParseCF::NotApplicable;
        }

        match (&second.kind, &first.kind, tok) {
            (
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::SELECT,
                    ..
                })),
                LR1Kind::ExpressionList(from_expression_list),
                _,
            ) => ParseCF::Reduced((2, LR1Kind::SelectStmt(from_expression_list.clone()))),
            (LR1Kind::SelectStmt(from_exprs), LR1Kind::ExpressionList(more_froms), _) => {
                let mut all_exprs = from_exprs.clone();
                all_exprs.append(more_froms.clone().as_mut());
                ParseCF::Reduced((2, LR1Kind::SelectStmt(all_exprs)))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_select_stmt(&self, tok: &Token) -> ParseCF {
        self.reduce_select_stmt_2(tok)
    }

    fn reduce_from_stmt(&self, tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        match (&second.kind, &first.kind, tok) {
            (
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::FROM,
                    ..
                })),
                LR1Kind::FromExpressionList(from_expression_list),
                next,
            ) if token_is_select_clause_boundary(next) => {
                ParseCF::Reduced((2, LR1Kind::FromStmt(from_expression_list.clone())))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_select_query_1(&self, tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match (&first.kind, tok) {
            (LR1Kind::SelectStmt(select_stmt), tok) if token_is_select_clause_boundary(tok) => {
                let select_query = SelectQuery {
                    columns: select_stmt.clone(),
                    from: None,
                    joins: vec![],
                };

                ParseCF::Reduced((1, LR1Kind::SelectQuery(Arc::new(select_query))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_select_query_2(&self, _tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        match (&second.kind, &first.kind) {
            (LR1Kind::SelectQuery(select_query), LR1Kind::FromStmt(from_stmt)) => {
                let mut new_query = select_query.as_ref().clone();
                new_query.from = Some(from_stmt.clone());

                ParseCF::Reduced((2, LR1Kind::SelectQuery(Arc::new(new_query))))
            }
            (LR1Kind::SelectQuery(select_query), LR1Kind::JoinStmt(join_stmt)) => {
                let mut new_query = select_query.as_ref().clone();
                new_query.joins.push(join_stmt.clone());

                ParseCF::Reduced((2, LR1Kind::SelectQuery(Arc::new(new_query))))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_select_query(&self, _tok: &Token) -> ParseCF {
        self.reduce_select_query_2(_tok)?;
        self.reduce_select_query_1(_tok)?;

        ParseCF::NotApplicable
    }

    fn reduce_join_kind_1(&self, _tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match &first.kind {
            LR1Kind::Token(Token::Word(Word {
                keyword: Keyword::JOIN,
                ..
            })) => ParseCF::Reduced((1, LR1Kind::JoinKind(JoinKind::Inner))),
            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_join_kind_2(&self, _tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        if let LR1Kind::Token(Token::Word(Word {
            keyword: Keyword::JOIN,
            ..
        })) = &first.kind
        {
            // pass
        } else {
            return ParseCF::NotApplicable;
        }

        match &second.kind {
            LR1Kind::Token(Token::Word(Word {
                keyword: Keyword::INNER,
                ..
            })) => ParseCF::Reduced((2, LR1Kind::JoinKind(JoinKind::Inner))),
            LR1Kind::Token(Token::Word(Word {
                keyword: Keyword::OUTER,
                ..
            })) => ParseCF::Reduced((2, LR1Kind::JoinKind(JoinKind::Outer))),
            LR1Kind::Token(Token::Word(Word {
                keyword: Keyword::LEFT,
                ..
            })) => ParseCF::Reduced((2, LR1Kind::JoinKind(JoinKind::Left))),
            LR1Kind::Token(Token::Word(Word {
                keyword: Keyword::RIGHT,
                ..
            })) => ParseCF::Reduced((2, LR1Kind::JoinKind(JoinKind::Right))),
            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_join_kind(&self, tok: &Token) -> ParseCF {
        self.reduce_join_kind_2(tok)?;
        self.reduce_join_kind_1(tok)
    }

    fn reduce_join_stmt_2(&self, tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        // Ignore this reduction if there's a join clause
        if let Token::Word(Word {
            keyword: Keyword::ON,
            ..
        }) = *tok
        {
            return ParseCF::NotApplicable;
        }

        match (&second.kind, &first.kind) {
            (LR1Kind::JoinKind(kind), LR1Kind::FromExpressionList(exp)) => {
                if exp.len() != 1 {
                    // Bad!
                    // Log something???
                }
                let from = exp[0].clone();

                ParseCF::Reduced((
                    2,
                    LR1Kind::JoinStmt(Arc::new(JoinExpression {
                        condition: None,
                        from,
                        join_kind: kind.clone(),
                    })),
                ))
            }
            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_join_stmt_4(&self, _tok: &Token) -> ParseCF {
        let (fourth, third, second, first) = self.get_4()?;

        match (&fourth.kind, &third.kind, &second.kind, &first.kind) {
            (
                LR1Kind::JoinKind(kind),
                LR1Kind::FromExpressionList(exp),
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::ON,
                    ..
                })),
                LR1Kind::Expression(on_exp),
            ) => {
                if exp.len() != 1 {
                    // Bad!
                    // Log something???
                }

                let from = exp[0].clone();

                ParseCF::Reduced((
                    4,
                    LR1Kind::JoinStmt(Arc::new(JoinExpression {
                        condition: Some(on_exp.clone()),
                        from,
                        join_kind: kind.clone(),
                    })),
                ))
            }
            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_join_stmt(&self, tok: &Token) -> ParseCF {
        self.reduce_join_stmt_4(&tok)?;
        self.reduce_join_stmt_2(&tok)
    }

    fn get_1(&self) -> Option<&LR1State> {
        if self.stack.len() < 1 {
            return None;
        }

        let first = self.stack.get(self.stack.len() - 1).unwrap();

        Some(first)
    }

    fn get_2(&self) -> Option<(&LR1State, &LR1State)> {
        if self.stack.len() < 2 {
            return None;
        }

        let second = self.stack.get(self.stack.len() - 2).unwrap();
        let first = self.stack.get(self.stack.len() - 1).unwrap();

        Some((second, first))
    }

    fn get_3(&self) -> Option<(&LR1State, &LR1State, &LR1State)> {
        if self.stack.len() < 3 {
            return None;
        }

        let third = self.stack.get(self.stack.len() - 3).unwrap();
        let second = self.stack.get(self.stack.len() - 2).unwrap();
        let first = self.stack.get(self.stack.len() - 1).unwrap();

        Some((third, second, first))
    }

    fn get_3_opt(
        &self,
    ) -> (
        Option<&Arc<LR1State>>,
        Option<&Arc<LR1State>>,
        Option<&Arc<LR1State>>,
    ) {
        let third = if self.stack.len() >= 3 {
            self.stack.get(self.stack.len() - 3)
        } else {
            None
        };

        let second = if self.stack.len() >= 2 {
            self.stack.get(self.stack.len() - 2)
        } else {
            None
        };

        let first = if self.stack.len() >= 1 {
            self.stack.get(self.stack.len() - 1)
        } else {
            None
        };

        (third, second, first)
    }

    fn get_4(&self) -> Option<(&LR1State, &LR1State, &LR1State, &LR1State)> {
        if self.stack.len() < 4 {
            return None;
        }

        let fourth = self.stack.get(self.stack.len() - 4).unwrap();
        let third = self.stack.get(self.stack.len() - 3).unwrap();
        let second = self.stack.get(self.stack.len() - 2).unwrap();
        let first = self.stack.get(self.stack.len() - 1).unwrap();

        Some((fourth, third, second, first))
    }
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum BestGuessContextKind {
    ColumnExpression,
    TableExpression,
    Keyword,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub struct LateralContext {
    pub kind: BestGuessContextKind,
    pub prefix: String,
    pub last_token: Token,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub struct ParserResult<'a> {
    pub states: Vec<Arc<LR1State>>,
    tokens: &'a Vec<Token>,
    source: &'a str,
    token_locations: Vec<Position>,
    token_offsets: Vec<usize>,
}

impl<'a> ParserResult<'a> {
    pub fn new(tokens: &'a Vec<Token>, source: &'a str, results: Vec<Arc<LR1State>>) -> Self {
        let mut token_locations = Vec::new();
        let mut token_offsets = Vec::new();

        let mut row = 0;
        let mut column = 0;
        let mut offset = 0;
        for token in tokens {
            token_locations.push(Position {
                line: row,
                character: column,
            });

            token_offsets.push(offset);

            let as_str = token.to_string();
            let has_newline = as_str.contains('\n');

            offset += as_str.len();
            match *token {
                Token::SingleQuotedString(ref s) => {
                    offset += s
                        .chars()
                        .fold(0, |acc, c| acc + if c == '\'' { 1 } else { 0 });
                }
                _ => {}
            };

            if has_newline {
                let split_strings = as_str.split('\n');
                row += (split_strings.count() - 1) as u32;

                let last_line = as_str.split('\n').last().unwrap();
                column = last_line.len() as u32;
            } else {
                column += as_str.len() as u32;
            }
        }

        Self {
            tokens,
            source,
            states: results,
            token_locations,
            token_offsets,
        }
    }

    pub fn inspect(&self, cursor_position: &Position) -> Option<Vec<Arc<LR1State>>> {
        let index = self
            .token_locations
            .iter()
            .enumerate()
            .fold(None, |acc, (i, position)| {
                if position > cursor_position {
                    acc
                } else {
                    Some(i)
                }
            })?;

        fn search_tree<'a>(states: &Vec<Arc<LR1State>>, index: u32) -> Vec<Arc<LR1State>> {
            for state in states {
                if index >= state.start && index < state.end {
                    let mut rec = search_tree(&state.children, index);
                    rec.push(state.clone());

                    return rec;
                }
            }

            Vec::new()
        }

        let res = search_tree(&self.states, index as u32);

        if res.len() == 0 {
            None
        } else {
            Some(res)
        }
    }

    pub fn get_context_kind(&self, cursor_position: &Position) -> LateralContext {
        let (token_index, ctx_kind, (prefix_start, prefix_length)) =
            self.tokens
                .into_iter()
                .zip(&self.token_locations)
                .zip(&self.token_offsets)
                .enumerate()
                .fold(
                    (0, BestGuessContextKind::Keyword, (0, 0)),
                    |(current_token, ctx_kind, prefix), (count, ((token, loc), offset))| {
                        if loc >= cursor_position {
                            return (current_token, ctx_kind, prefix);
                        }

                        let kind = match *token {
                            Token::Word(Word {
                                keyword:
                                    Keyword::SELECT
                                    | Keyword::VALUES
                                    | Keyword::WHERE
                                    | Keyword::GROUP
                                    | Keyword::HAVING
                                    | Keyword::ORDER
                                    | Keyword::LIMIT
                                    | Keyword::OFFSET
                                    | Keyword::SET
                                    | Keyword::ON,
                                ..
                            }) => BestGuessContextKind::ColumnExpression,
                            Token::Word(Word {
                                keyword:
                                    Keyword::FROM | Keyword::JOIN | Keyword::UPDATE | Keyword::INTO,
                                ..
                            }) => BestGuessContextKind::TableExpression,
                            Token::Word(Word {
                                keyword:
                                    Keyword::INSERT
                                    | Keyword::INNER
                                    | Keyword::OUTER
                                    | Keyword::LEFT
                                    | Keyword::DELETE,
                                ..
                            }) => BestGuessContextKind::Keyword,
                            _ => ctx_kind,
                        };

                        // Tokens can't split lines, so we can compute length based off of column
                        let distance_to_cursor = if cursor_position.line != loc.line {
                            0
                        } else {
                            cursor_position.character - loc.character
                        };

                        (count, kind, (*offset as usize, distance_to_cursor as usize))
                    },
                );

        return LateralContext {
            kind: ctx_kind,
            last_token: self.tokens.get(token_index).unwrap().clone(),
            prefix: self.source[prefix_start..(prefix_start + prefix_length)].to_string(),
        };
    }
}

fn token_is_select_clause_boundary(tok: &Token) -> bool {
    match tok {
        Token::Word(Word {
            keyword:
                Keyword::FROM
                | Keyword::WHERE
                | Keyword::GROUP
                | Keyword::HAVING
                | Keyword::ORDER
                | Keyword::LIMIT
                | Keyword::OFFSET
                | Keyword::UNION
                | Keyword::EXCEPT
                | Keyword::INTERSECT
                | Keyword::FETCH
                | Keyword::FOR
                | Keyword::INNER
                | Keyword::OUTER
                | Keyword::LEFT
                | Keyword::RIGHT
                | Keyword::JOIN,
            ..
        })
        | Token::SemiColon
        | Token::EOF
        | Token::RParen => true,
        _ => false,
    }
}
