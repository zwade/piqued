use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::tokenizer::{Tokenizer, Token};
use piqued::loose_parser::parse::ParserContext;

fn partially_parse() {
    let dialect = PostgreSqlDialect {};
    let sql = "
        SELECT foo.bar some_column, 3 as some_number;
    ";
    let tokens = Tokenizer::new(&dialect, sql).tokenize().unwrap();

    let mut token_prediction = ParserContext::new(&tokens);
    let predictions = token_prediction.parse();

    predictions
        .iter()
        .for_each(|pred| {
            println!("{:#?}", pred.kind);
        });
}

fn main() {
    partially_parse();
}