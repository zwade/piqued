use std::sync::Arc;

use sqlparser::{
    dialect::PostgreSqlDialect,
    keywords::Keyword,
    tokenizer::{Token, Tokenizer, Word},
};
use tower_lsp::lsp_types::Position;

use super::parse_cf::{
    BinopExpression, ColumnExpression, Expression, FromExpression, LR1Kind, LR1State, Operator,
    ParseCF, SelectQuery, TableLike, UnopExpression,
};

pub struct ParserContext {
    tokens: Vec<Token>,

    next_token: usize,
    stack: Vec<Arc<LR1State>>,
}

impl ParserContext {
    pub fn new(sql: &String) -> Self {
        let dialect = PostgreSqlDialect {};
        let tokens = Tokenizer::new(&dialect, sql).tokenize().unwrap();

        ParserContext {
            tokens,
            next_token: 0,
            stack: vec![],
        }
    }

    pub fn parse<'a>(&'a mut self) -> ParserResult<'a> {
        loop {
            let result = self.iterate_once();
            match result {
                ParseCF::NotApplicable => {
                    if self.next_token >= self.tokens.len() {
                        break;
                    } else {
                        self.next_token += 1;
                    }
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

        ParserResult::new(&self.tokens, self.stack.clone())
    }

    fn iterate_once(&mut self) -> ParseCF {
        let tok = self.tokens.get(self.next_token).unwrap_or(&Token::EOF);

        self.reduce_expression_1(tok)?;
        self.reduce_operators(tok)?;
        self.reduce_wildcard(tok)?;

        self.shift_operators(tok)?;

        self.reduce_expression_list(tok)?;
        self.reduce_from_expression_list(tok)?;
        self.reduce_select_stmt(tok)?;
        self.reduce_from_stmt(tok)?;
        self.reduce_select_query(tok)?;

        self.shift_identifier(tok)?;
        self.shift_keyword(tok)?;
        self.shift_whitespace(tok)?;

        if let Token::EOF = tok {
            ParseCF::NotApplicable
        } else {
            ParseCF::Shifted(LR1Kind::Token(tok.clone()))
        }
    }

    fn shift_whitespace(&self, tok: &Token) -> ParseCF {
        match tok {
            Token::Whitespace(_) => ParseCF::ReduceWhitespace,
            Token::SemiColon => ParseCF::ReduceWhitespace,
            _ => ParseCF::NotApplicable,
        }
    }

    fn shift_identifier(&self, tok: &Token) -> ParseCF {
        match tok {
            Token::Word(Word {
                keyword: Keyword::NoKeyword,
                value,
                ..
            }) => ParseCF::Shifted(LR1Kind::Expression(Arc::new(Expression::Identifier(
                value.clone(),
            )))),

            _ => ParseCF::NotApplicable,
        }
    }

    fn shift_keyword(&self, tok: &Token) -> ParseCF {
        match tok {
            Token::Word(Word {
                keyword: Keyword::SELECT,
                ..
            }) => ParseCF::Shifted(LR1Kind::Token(tok.clone())),

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

    fn reduce_expression_list_1(&self, _tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match &first.kind {
            LR1Kind::ColumnExpression(e) => {
                ParseCF::Reduced((1, LR1Kind::ExpressionList(vec![e.clone()])))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_expression_list_3(&self, _tok: &Token) -> ParseCF {
        let (third, second, first) = self.get_3()?;

        match (&third.kind, &second.kind, &first.kind) {
            (
                LR1Kind::ExpressionList(exp),
                LR1Kind::Token(Token::Comma),
                LR1Kind::ColumnExpression(e2),
            ) => {
                let mut new_list = exp.clone();
                new_list.push(e2.clone());
                ParseCF::Reduced((3, LR1Kind::ExpressionList(new_list)))
            }

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_expression_list(&self, tok: &Token) -> ParseCF {
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
        self.reduce_column_expression_1(tok)?;
        self.reduce_expression_list_3(tok)?;
        self.reduce_expression_list_1(tok)?;
        ParseCF::NotApplicable
    }

    fn reduce_table_like_2(&self, _tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        match (&second.kind, &first.kind) {
            (
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::FROM,
                    ..
                })),
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

    fn reduce_select_stmt(&self, tok: &Token) -> ParseCF {
        let (second, first) = self.get_2()?;

        match (&second.kind, &first.kind, tok) {
            (
                LR1Kind::Token(Token::Word(Word {
                    keyword: Keyword::SELECT,
                    ..
                })),
                LR1Kind::ExpressionList(from_expression_list),
                next,
            ) if token_is_select_clause_boundary(next) => {
                ParseCF::Reduced((2, LR1Kind::SelectStmt(from_expression_list.clone())))
            }

            _ => ParseCF::NotApplicable,
        }
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

    fn reduce_select_query_1(&self, _tok: &Token) -> ParseCF {
        let first = self.get_1()?;

        match &first.kind {
            LR1Kind::SelectStmt(select_stmt) => {
                let select_query = SelectQuery {
                    columns: select_stmt.clone(),
                    from: None,
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

            _ => ParseCF::NotApplicable,
        }
    }

    fn reduce_select_query(&self, _tok: &Token) -> ParseCF {
        self.reduce_select_query_2(_tok)?;
        self.reduce_select_query_1(_tok)?;

        ParseCF::NotApplicable
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
}

pub struct ParserResult<'a> {
    pub states: Vec<Arc<LR1State>>,
    _tokens: &'a Vec<Token>,
    token_locations: Vec<Position>,
}

impl<'a> ParserResult<'a> {
    pub fn new(tokens: &'a Vec<Token>, results: Vec<Arc<LR1State>>) -> Self {
        let mut token_locations = Vec::new();

        let mut row = 0;
        let mut column = 0;
        for token in tokens {
            token_locations.push(Position {
                line: row,
                character: column,
            });

            let as_str = token.to_string();
            let has_newline = as_str.contains('\n');

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
            _tokens: tokens,
            states: results,
            token_locations,
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
                | Keyword::FOR,
            ..
        })
        | Token::SemiColon
        | Token::EOF
        | Token::RParen => true,
        _ => false,
    }
}
