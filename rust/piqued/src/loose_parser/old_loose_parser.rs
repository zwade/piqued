use std::collections::{HashMap, HashSet};

use sqlparser::{tokenizer::{Token, Word}, keywords::Keyword};

#[derive(Debug, Clone, Eq, PartialEq, Hash)]
pub struct Expression {
    is_select: bool,
}

#[derive(Debug, Clone, Eq, PartialEq, Hash)]
pub enum TokenPrediction {
    StartOfSegment,

    AnyWord,
    SomeWord(String),

    Expression(Expression),

    Table,
    TableAliasFor(String),
    ColumnAliasFor(String),
}

pub struct TokenPredictionContext<'a> {
    table_aliases: HashMap<String, String>,
    column_aliases: HashMap<String, String>,
    tables_in_context: Vec<String>,
    tokens: &'a Vec<Token>,

    next_token: usize,
    token_predictions: Vec<Vec<TokenPrediction>>,
}

impl<'a> TokenPredictionContext<'a> {
    pub fn new(tokens: &'a Vec<Token>) -> Self {
        TokenPredictionContext {
            table_aliases: HashMap::new(),
            column_aliases: HashMap::new(),
            tables_in_context: Vec::new(),

            tokens,
            next_token: 0,
            token_predictions: vec![vec![TokenPrediction::StartOfSegment]],
        }
    }

    pub fn parse(&mut self) -> &Vec<Vec<TokenPrediction>> {
        while let Some(_) = self.feed() { }

        &self.token_predictions
    }

    fn feed(&mut self) -> Option<usize> {
        let mut predictions = HashSet::new();
        predictions.insert(TokenPrediction::StartOfSegment);

        if self.next_token >= self.tokens.len() {
            self.token_predictions.push(predictions.into_iter().collect());
            return None;
        }

        let next_token = self.tokens.get(self.next_token).unwrap();

        let new_predictions: Vec<TokenPrediction> = self.token_predictions
            .get(self.next_token)
            .unwrap_or(&vec![])
            .iter()
            .flat_map(
                |prediction| {
                    self.feed_with_prediction(next_token, prediction)
                }
            )
            .collect();

        predictions.extend(new_predictions);

        self.token_predictions.push(predictions.into_iter().collect());
        self.next_token += 1;
        Some(self.next_token)
    }

    fn feed_with_prediction(&self, token: &Token, prediction: &TokenPrediction) -> Vec<TokenPrediction> {
        let mut result: Vec<TokenPrediction> = vec![];

        match (token, prediction) {
            (
                Token::Whitespace(_),
                context
            ) =>
                result.push(context.clone()),

            (
                Token::Word(Word{ keyword: Keyword::SELECT, .. }),
                TokenPrediction::StartOfSegment
            ) =>
                result.push(TokenPrediction::Expression(Expression { is_select: true })),

            (
                token,
                TokenPrediction::Expression(_exp)
            )
            if self.token_is_in_expression(token) =>
                result.push(TokenPrediction::Expression(Expression { is_select: true })),

            _ => (),
        };

        result
    }

    fn token_is_in_expression(&self, token: &Token) -> bool {
        match token {
            Token::Ampersand => false,
            Token::Arrow => false,
            Token::AtSign => false,
            Token::Backslash => false,
            Token::Caret => false,
            Token::Char(_) => true,
            Token::Colon => false,
            Token::Comma => true, // We call commas expressions because they appear in select
            Token::Div => true,
            Token::DoubleColon => true, // Casts can tentatively be considered expressions
            Token::DoubleEq => true, // Never really occurs in PGsql but w/e
            Token::DoubleExclamationMark => true,
            Token::DoubleQuotedString(_) => true,
            Token::EOF => false,
            Token::Eq => true,
            Token::EscapedStringLiteral(_) => true,
            Token::ExclamationMark => true,
            Token::ExclamationMarkTilde => true,
            Token::ExclamationMarkTildeAsterisk => true,
            Token::Gt => true,
            Token::GtEq => true,
            Token::HashArrow => true,
            Token::HashLongArrow => true,
            Token::HexStringLiteral(_) => true,
            Token::LBrace => false,
            Token::LBracket => false,
            Token::LParen => true,
            Token::LongArrow => false,
            Token::Lt => true,
            Token::LtEq => true,
            Token::Minus => true,
            Token::Mod => true,
            Token::Mul => true,
            Token::NationalStringLiteral(_) => true, // Did they nationalize my string literals???
            Token::Neq => true,
            Token::Number(_, _) => true,
            Token::PGCubeRoot => true, // Sigh
            Token::PGSquareRoot => true,
            Token::Period => true, // Might need to treat this differently?
            Token::Pipe => false, // Hmm, need to look up what this is
            Token::Placeholder(_) => true,
            Token::Plus => true,
            Token::RArrow => false, // Maybe?
            Token::RBrace => false,
            Token::RBracket => false,
            Token::RParen => true,
            Token::SemiColon => false,
            Token::Sharp => true,
            Token::ShiftLeft => true,
            Token::ShiftRight => true,
            Token::SingleQuotedString(_) => true,
            Token::Spaceship => true, // ;__;
            Token::StringConcat => true,
            Token::Tilde => true,
            Token::TildeAsterisk => true,
            Token::Whitespace(_) => false,

            Token::Word(Word { keyword: Keyword::NoKeyword, .. }) => true,
            Token::Word(_) => false,
        }
    }

}
