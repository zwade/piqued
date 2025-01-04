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

    pub variables: Vec<Node>,
    pub details: ParsedDetails,
    pub contents: String,
}

#[derive(Debug, PartialEq, Clone)]
pub struct ParsedFile {
    pub statements: Vec<RelocatedStmt>,
    pub tokens: Vec<ScanToken>,
}

#[derive(Debug, PartialEq, Clone)]
pub struct Template {
    pub name: String,
    example: String,
}

#[derive(Debug, PartialEq, Clone)]
pub struct ParsedDetails {
    pub comment: String,
    pub name: String,
    pub params: Option<Vec<String>>,
    pub templates: Vec<Template>,
}

pub fn parse_single_query<'a>(
    query: &str,
    offset: usize,
    tokens: &Vec<ScanToken>,
    details: &ParsedDetails,
) -> Result<(RawStmt, String)> {
    let mut in_prepare = false;

    let mut strings_with_variables: Vec<&str> = vec![];
    let mut strings_with_examples: Vec<&str> = vec![];
    let mut last_end = None;
    let mut i = 0;

    loop {
        if i >= tokens.len() {
            break;
        }

        let token = &tokens[i];

        match token.token() {
            Token::WhitespaceP | Token::CComment | Token::SqlComment => {}
            Token::Ascii58
                if (!in_prepare
                    && i + 1 < tokens.len()
                    && tokens[i + 1].token() == Token::Ident) =>
            {
                let start = tokens[i + 1].start as usize - offset;
                let end = tokens[i + 1].end as usize - offset;
                let name = &query[start..end];

                let template_example = details.templates.iter().find(|templ| templ.name == name);

                strings_with_examples.push(" ");
                strings_with_variables.push(" ");

                if let Some(tmpl) = template_example {
                    strings_with_examples.push(&tmpl.example);
                } else {
                    strings_with_examples.push(":");
                    strings_with_examples.push(name);
                }

                strings_with_variables.push(":");
                strings_with_variables.push("__tmpl_");
                strings_with_variables.push(name);

                last_end = Some(end);
                i += 1;
            }
            tok => {
                if tok == Token::Prepare {
                    in_prepare = true;
                }

                let start = token.start as usize - offset;
                let end = token.end as usize - offset;

                if let Some(val) = last_end {
                    if start > val {
                        strings_with_examples.push(" ");

                        if !in_prepare {
                            strings_with_variables.push(" ");
                        }
                    }
                }

                strings_with_examples.push(&query[start..end]);

                if !in_prepare {
                    strings_with_variables.push(&query[start..end]);
                }

                last_end = Some(end);

                if tok == Token::As {
                    in_prepare = false;
                }
            }
            _ => {}
        }

        i += 1;
    }

    let full_query = strings_with_examples.join("");
    let templated_query = strings_with_variables.join("");

    let stmts = pg_query::parse(&full_query)?.protobuf.stmts;
    if stmts.len() == 0 {
        return Err(PiquedError::OtherError(query.to_string()));
    }

    Ok((stmts[0].clone(), templated_query))
}

pub fn load_file(contents: &str) -> Result<ParsedFile> {
    let tokens = pg_query::scan(&contents)?.tokens;
    let mut token_set = vec![vec![]];

    for token in &tokens {
        let last = token_set.last_mut().unwrap();
        last.push(token.clone());
        if (Token::Ascii59 as i32) == token.token {
            token_set.push(vec![]);
        }
    }

    let mut start_offset = 0;
    let queries = token_set
        .iter()
        .filter_map(|vec| {
            if vec.len() == 0 {
                return None;
            }

            let last_tok = vec.last().unwrap();
            let content = &contents[start_offset as usize..last_tok.end as usize];
            start_offset = last_tok.end;

            Some(content.to_string())
        })
        .collect::<Vec<_>>();

    // A mapping of each line to its offset in the file
    let index_by_line: Vec<u32> = (contents.to_string() + "\n")
        .split("\n")
        .scan(0, |acc, line| {
            let result = acc.clone();
            *acc += line.len() + 1;
            Some(result as u32)
        })
        .collect();

    // A method to get the line & column position for a
    // given offset
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

    let relocated_statements: Vec<RelocatedStmt> = queries
        .iter()
        .enumerate()
        .zip(token_set.iter())
        .scan(0, |state, ((i, query), tokens)| {
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

            let mut details =
                get_details(tokens, query, location as usize, || format!("query_{}", i));
            let stmt = parse_single_query(query, location as usize, tokens, &details);

            let (parsed_stmt, contents, prep_name, variables) = match stmt {
                Ok((stmt, templated_query)) => {
                    let (stmt, name, args) = get_prepared_statement(stmt);
                    (Ok(stmt), templated_query, name, args)
                }
                Err(e) => (Err(e), query.to_string(), None, vec![]),
            };

            if let Some(name) = prep_name {
                details.name = name;
            }

            Some(RelocatedStmt {
                stmt: parsed_stmt,
                range: get_range(index_start, index_len),
                index_start,
                index_len,
                details,
                contents,
                variables,
            })
        })
        .collect();

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
    let mut templates: Vec<Template> = vec![];
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
        } else if trimmed_comment.starts_with("@xtemplate") {
            let mut template_iter = trimmed_comment.split(" ").into_iter();

            template_iter.next();
            match (template_iter.next(), template_iter.next()) {
                (Some(name), Some(example)) => {
                    templates.push(Template {
                        name: name.to_string(),
                        example: example.to_string(),
                    });
                }
                _ => {
                    comment_lines.push(trimmed_comment.to_string());
                }
            }
        } else {
            comment_lines.push(trimmed_comment.to_string());
        }
    }

    return ParsedDetails {
        comment: comment_lines.join("\n"),
        name: name.unwrap_or_else(default_name),
        params,
        templates,
    };
}

pub fn get_details<F>(
    tokens: &Vec<ScanToken>,
    content: &str,
    offset: usize,
    default_name: F,
) -> ParsedDetails
where
    F: FnOnce() -> String,
{
    let mut comments: Vec<String> = vec![];

    for token in tokens {
        match token.token() {
            Token::WhitespaceP => {}
            Token::CComment | Token::SqlComment => {
                let comment = &content[token.start as usize - offset..token.end as usize - offset];
                comments.push(comment.to_string());
            }
            _ => break,
        }
    }

    let comments = comments.join("\n");
    let details = parse_comment(&comments, default_name);

    details
}

pub fn get_prepared_statement(stmt: RawStmt) -> (RawStmt, Option<String>, Vec<Node>) {
    let stmt = stmt.clone();

    if let Some(box_stmt) = stmt.stmt {
        return match *box_stmt {
            protobuf::Node {
                node: Some(protobuf::node::Node::PrepareStmt(prep_stmt)),
            } => (
                protobuf::RawStmt {
                    stmt: prep_stmt.query,
                    ..Default::default()
                },
                Some(prep_stmt.name.clone()),
                prep_stmt.argtypes.clone(),
            ),
            stmt => (
                protobuf::RawStmt {
                    stmt: Some(Box::new(stmt)),
                    ..Default::default()
                },
                None,
                vec![],
            ),
        };
    } else {
        (stmt, None, vec![])
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
