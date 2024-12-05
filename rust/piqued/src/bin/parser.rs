use piqued::loose_parser::parse::ParserContext;
use tower_lsp::lsp_types::Position;

fn partially_parse() {
    // let sql = "
    //     SELECT 1->>2, foo.bar as column_sample, |/3 as number_sample, -3 <=> +2
    //     FROM company as foo, other bar;
    // ";
    let sql: &str = r"
SELECT person, practice,
FROM person
INNER JOIN practice_person_patient ppp
    ON ppp.person_uid = person.uid
INNER JOIN practice
    ON
;
    ";
    println!("Attempting to parse: {}", sql);
    let mut token_prediction = ParserContext::new(&sql.to_string());
    let predictions = token_prediction.parse();
    let stack = predictions.inspect(&Position {
        line: 2,
        character: 3,
    });

    predictions.states.iter().for_each(|pred| {
        println!("{:#?}", pred.kind);
    });
}

fn main() {
    partially_parse();
}
