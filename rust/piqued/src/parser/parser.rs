use crate::utils::result::{PiquedError, Result};
use pg_query::{
    protobuf::{self, ParseResult, RawStmt, ScanToken, Token},
    Node, NodeEnum,
};
use tower_lsp::lsp_types::{Position, Range};

#[derive(Debug, PartialEq, Clone)]
pub struct RelocatedStmt {
    pub stmt: Result<RawStmt>,

    pub range: Range,
    pub index_start: u32,
    pub index_len: u32,
}

pub struct ParsedFile {
    pub statements: Vec<RelocatedStmt>,
    pub tokens: Vec<ScanToken>,
}

#[derive(Debug, PartialEq, Clone)]
pub struct ParsedDetails {
    pub comment: String,
    pub name: String,
    pub params: Option<Vec<String>>,
}

pub struct ParsedPreparedQuery {
    pub query: RawStmt,
    pub variables: Vec<Node>,
    pub details: ParsedDetails,
    pub contents: String,
}

pub fn parse_single_query<'a>(query: &str) -> Result<RawStmt> {
    let stmts = pg_query::parse(query)?.protobuf.stmts;
    if stmts.len() == 0 {
        return Err(PiquedError::OtherError(query.to_string()));
    }

    Ok(stmts[0].clone())
}

pub fn load_file(contents: &str) -> Result<ParsedFile> {
    let queries = contents.split(";").collect::<Vec<_>>();
    let index_by_line: Vec<u32> = (contents.to_string() + "\n")
        .split("\n")
        .scan(0, |acc, line| {
            let result = acc.clone();
            *acc += line.len() + 1;
            Some(result as u32)
        })
        .collect();

    let get_position = |index: u32| {
        let line = index_by_line
            .iter()
            .enumerate()
            .find(|(_, &x)| x > index)
            .map(|(i, _)| i - 1)
            .unwrap_or(0);

        let column = index - index_by_line[line];

        Position::new(line as u32, column as u32)
    };

    let get_range =
        |start: u32, len: u32| Range::new(get_position(start), get_position(start + len));

    let parsed_statements: Vec<Result<RawStmt>> = queries
        .iter()
        .map(|query| parse_single_query(query))
        .collect();

    let relocated_statements: Vec<RelocatedStmt> = parsed_statements
        .iter()
        .zip(queries.iter())
        .scan(0, |state, (stmt, query)| {
            let mut whitespace = 0;
            for c in query.chars() {
                if c.is_whitespace() {
                    whitespace += 1;
                } else {
                    break;
                }
            }

            let location = *state;
            let len = query.len() as u32;
            *state += &len;

            let index_start = location + whitespace as u32;
            let index_len = len - whitespace as u32;

            if index_len == 0 {
                return None;
            }

            *state += 1; // For the semicolon

            Some(RelocatedStmt {
                stmt: stmt.clone(),
                range: get_range(index_start, index_len),
                index_start,
                index_len,
            })
        })
        .collect();

    let tokens = pg_query::scan(&contents)?.tokens;

    return Ok(ParsedFile {
        statements: relocated_statements,
        tokens,
    });
}

fn parse_comment<F>(string: &String, default_name: F) -> ParsedDetails
where
    F: FnOnce() -> String,
{
    let mut name: Option<String> = None;
    let mut params: Option<Vec<String>> = None;
    let mut comment_lines: Vec<String> = vec![];

    for line in string.lines() {
        let trimmed_comment = line
            .trim_start_matches("/**")
            .trim_start_matches("/*")
            .trim_end_matches("*/")
            .trim_start_matches(vec![' ', '\t'].as_slice())
            .trim_start_matches("-- ")
            .trim_start_matches("* ")
            .trim_end();

        if trimmed_comment.starts_with("@name") {
            name = trimmed_comment
                .split(" ")
                .nth(1)
                .map(|s| s.trim().to_string());
        } else if trimmed_comment.starts_with("@params") {
            let mut param_iter = trimmed_comment.split(" ").into_iter();

            param_iter.next();
            params = Some(param_iter.map(|val| val.trim().to_string()).collect());
        } else {
            comment_lines.push(trimmed_comment.to_string());
        }
    }

    return ParsedDetails {
        comment: comment_lines.join("\n"),
        name: name.unwrap_or_else(default_name),
        params,
    };
}

pub fn get_prepared_statement<F>(
    obj: &RelocatedStmt,
    tokens: &Vec<ScanToken>,
    content: &str,
    default_name: F,
) -> Result<ParsedPreparedQuery>
where
    F: FnOnce() -> String,
{
    let start = obj.index_start;
    let stmt = obj.stmt.clone()?;

    let mut comments: Vec<String> = vec![];

    for token in tokens {
        if token.start as u32 >= start {
            match token.token() {
                Token::CComment | Token::SqlComment => {
                    let comment = &content[token.start as usize..token.end as usize];
                    comments.push(comment.to_string());
                }
                _ => break,
            }
        }
    }

    let comments = comments.join("\n");
    if let Some(box_stmt) = stmt.stmt {
        return match *box_stmt {
            protobuf::Node {
                node: Some(protobuf::node::Node::PrepareStmt(prep_stmt)),
            } => {
                let statement = protobuf::RawStmt {
                    stmt: prep_stmt.query.clone(),
                    stmt_location: 0,
                    stmt_len: 0,
                };

                let details = parse_comment(&comments, || prep_stmt.name.clone());

                Ok(ParsedPreparedQuery {
                    contents: deparse_statement(&statement),
                    query: statement,
                    variables: prep_stmt.argtypes.clone(),
                    details,
                })
            }

            stmt => {
                let statement = protobuf::RawStmt {
                    stmt: Some(Box::new(stmt)),
                    stmt_location: 0,
                    stmt_len: 0,
                };

                let details = parse_comment(&comments, default_name);

                Ok(ParsedPreparedQuery {
                    contents: deparse_statement(&statement),
                    query: statement,
                    variables: vec![],
                    details,
                })
            }
        };
    } else {
        Err(PiquedError::OtherError("No statement found".to_string()))
    }
}

fn deparse_statement(stmt: &RawStmt) -> String {
    let as_prepared_statement = ParseResult {
        stmts: vec![RawStmt {
            stmt: stmt.stmt.clone(),

            stmt_len: 0,
            stmt_location: 0,
        }],
        version: 160001,
    };

    as_prepared_statement.deparse().unwrap()
}

pub fn node_to_string(node: Node) -> Option<String> {
    match node.node {
        Some(NodeEnum::String(str)) => Some(str.sval),
        _ => None,
    }
}
