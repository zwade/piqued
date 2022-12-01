use piqued::loose_parser::parse::ParserContext;
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::tokenizer::Tokenizer;

fn partially_parse() {
    let dialect = PostgreSqlDialect {};
    let sql = "
        SELECT
        FROM company as foo, other bar;
    ";
    let tokens = Tokenizer::new(&dialect, sql).tokenize().unwrap();

    println!("Attempting to parse: {}", sql);
    let mut token_prediction = ParserContext::new(&tokens);
    let predictions = token_prediction.parse();

    predictions.iter().for_each(|pred| {
        println!("{:#?}", pred.kind);
    });
}

fn main() {
    partially_parse();
}
