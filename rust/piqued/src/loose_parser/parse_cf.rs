use std::{
    convert::Infallible,
    ops::{ControlFlow, FromResidual, Try},
    sync::Arc,
};

use sqlparser::tokenizer::Token;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct Column {
    pub name: String,
    pub table: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum Expression {
    Column(Column),
    StringLiteral(String),
    NumberLiteral(String),
    NullLiteral,
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
    Column(Column),
    ColumnExpression(Arc<ColumnExpression>),
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
