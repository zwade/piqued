use sqlparser::{
    keywords::Keyword,
    tokenizer::{Token, Word},
};

use super::parse_cf::{Binop, Operator, Unop};

impl Operator {
    pub fn binop_from_token(tok: &Token) -> Option<Operator> {
        match tok {
            Token::Period => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 1,
            })),
            Token::DoubleColon => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 2,
            })),
            // Square brackets (are they binops???)
            Token::Caret => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 5,
            })),
            Token::Mul | Token::Div | Token::Mod => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 6,
            })),
            Token::Plus | Token::Minus => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 7,
            })),
            Token::ExclamationMarkTilde
            | Token::ExclamationMarkTildeAsterisk
            | Token::HashArrow
            | Token::HashLongArrow
            | Token::LongArrow
            | Token::Pipe
            | Token::RArrow
            | Token::Sharp
            | Token::ShiftLeft
            | Token::ShiftRight
            | Token::Spaceship
            | Token::StringConcat
            | Token::Tilde
            | Token::TildeAsterisk => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 8,
            })),
            Token::Word(Word {
                keyword:
                    Keyword::LIKE | Keyword::ILIKE | Keyword::BETWEEN | Keyword::IN | Keyword::SIMILAR,
                ..
            }) => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 9,
            })),
            Token::Lt | Token::LtEq | Token::Gt | Token::GtEq | Token::Eq | Token::Neq => {
                Some(Operator::Binop(Binop {
                    token: tok.clone(),
                    precedence: 10,
                }))
            }
            Token::Word(Word {
                keyword: Keyword::IS,
                ..
            }) => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 12,
            })),
            Token::Word(Word {
                keyword: Keyword::AND,
                ..
            }) => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 13,
            })),
            Token::Word(Word {
                keyword: Keyword::OR,
                ..
            }) => Some(Operator::Binop(Binop {
                token: tok.clone(),
                precedence: 14,
            })),
            _ => None,
        }
    }

    pub fn unop_from_token(token: &Token) -> Option<Operator> {
        match token {
            Token::Plus | Token::Minus => Some(Operator::Unop(Unop {
                token: token.clone(),
                precedence: 4,
            })),
            Token::PGSquareRoot | Token::PGCubeRoot => Some(Operator::Unop(Unop {
                token: token.clone(),
                precedence: 8,
            })),
            Token::Word(Word {
                keyword: Keyword::NOT,
                ..
            }) => Some(Operator::Unop(Unop {
                token: token.clone(),
                precedence: 11,
            })),
            _ => None,
        }
    }

    pub fn precedence_from_token(token: &Token) -> Option<u8> {
        if let Some(Operator::Binop(op)) = Self::binop_from_token(token) {
            Some(op.precedence)
        } else if let Some(Operator::Unop(op)) = Self::unop_from_token(token) {
            Some(op.precedence)
        } else {
            None
        }
    }
}
