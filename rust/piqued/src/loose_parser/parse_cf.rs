use std::{
    convert::Infallible,
    ops::{ControlFlow, FromResidual, Try},
    sync::Arc,
};

use sqlparser::tokenizer::Token;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct Unop {
    pub token: Token,
    pub precedence: u8,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct Binop {
    pub token: Token,
    pub precedence: u8,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum Operator {
    Unop(Unop),
    Binop(Binop),
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct BinopExpression {
    pub left: Arc<Expression>,
    pub right: Arc<Expression>,
    pub operator: Binop,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct UnopExpression {
    pub expression: Arc<Expression>,
    pub operator: Unop,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum Expression {
    Identifier(String),
    StringLiteral(String),
    NumberLiteral(String),
    NullLiteral,
    WildcardLiteral,
    ScopedWildcardLiteral(String),
    BinopExpression(BinopExpression),
    UnopExpression(UnopExpression),
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum ColumnExpression {
    Unnamed(Arc<Expression>),
    Named(String, Arc<Expression>),
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum TableLike {
    Table(String),
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct FromExpression {
    pub table: Arc<TableLike>,
    pub alias: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct SelectQuery {
    pub columns: Vec<Arc<ColumnExpression>>,
    pub from: Option<Vec<Arc<FromExpression>>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum LR1Kind {
    Token(Token),
    ColumnExpression(Arc<ColumnExpression>),
    Operator(Operator),
    ExpressionList(Vec<Arc<ColumnExpression>>),
    Expression(Arc<Expression>),
    TableLike(Arc<TableLike>),
    FromExpression(Arc<FromExpression>),
    FromExpressionList(Vec<Arc<FromExpression>>),

    SelectStmt(Vec<Arc<ColumnExpression>>),
    FromStmt(Vec<Arc<FromExpression>>),

    SelectQuery(Arc<SelectQuery>),
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct LR1State {
    pub start: u32,
    pub end: u32,
    pub kind: LR1Kind,
    pub children: Vec<Arc<LR1State>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum ParseCF {
    NotApplicable,
    Shifted(LR1Kind),
    Reduced((u32, LR1Kind)),
    ReduceWhitespace,
}

impl FromResidual<ParseCF> for ParseCF {
    fn from_residual(residual: ParseCF) -> Self {
        residual
    }
}

impl FromResidual<Option<Infallible>> for ParseCF {
    fn from_residual(residual: Option<Infallible>) -> Self {
        match residual {
            None => ParseCF::NotApplicable,
            Some(never) => match never {},
        }
    }
}

impl FromResidual<()> for ParseCF {
    fn from_residual(_: ()) -> Self {
        ParseCF::NotApplicable
    }
}

impl Try for ParseCF {
    type Output = ();
    type Residual = ParseCF;

    fn branch(self) -> ControlFlow<Self::Residual, Self::Output> {
        match self {
            ParseCF::NotApplicable => ControlFlow::Continue(()),
            ParseCF::Shifted(shifted) => ControlFlow::Break(ParseCF::Shifted(shifted)),
            ParseCF::Reduced(reduced) => ControlFlow::Break(ParseCF::Reduced(reduced)),
            ParseCF::ReduceWhitespace => ControlFlow::Break(ParseCF::ReduceWhitespace),
        }
    }

    fn from_output(_output: Self::Output) -> Self {
        ParseCF::NotApplicable
    }
}
