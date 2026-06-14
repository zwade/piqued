use std::collections::HashMap;

use crate::utils::result::{PiquedError, Result};
use pg_query::{
    protobuf::{self, ParseResult, RawStmt, ScanToken, Token},
    Node, NodeEnum,
};
use tower_lsp::lsp_types::{Position, Range};

#[derive(Debug, PartialEq, Clone)]
pub struct RelocatedQuery {
    pub stmt: Result<RawStmt>,

    pub range: Range,
    pub index_start: u32,
    pub index_len: u32,

    pub variables: Vec<Node>,
    pub details: QueryDetails,
    pub contents: String,
}

#[derive(Debug, PartialEq, Clone)]
pub struct RelocatedFragment {
    pub stmt: Result<RawStmt>,

    pub range: Range,
    pub index_start: u32,
    pub index_len: u32,

    pub details: FragmentDetails,
    pub contents: String,
}

#[derive(Debug, PartialEq, Clone)]
pub struct ParsedFile {
    pub queries: Vec<RelocatedQuery>,
    pub fragments: HashMap<String, RelocatedFragment>,
    pub tokens: Vec<ScanToken>,
}

#[derive(Debug, PartialEq, Clone)]
pub struct Template {
    pub name: String,
    example: String,
}

#[derive(Debug, PartialEq, Clone)]
pub struct QueryDetails {
    pub comment: String,
    pub name: String,
    pub params: Option<Vec<String>>,
    pub templates: Vec<Template>,
}

#[derive(Debug, PartialEq, Clone)]
pub struct FragmentDetails {
    pub comment: String,
    pub name: String,
}

#[derive(Debug, PartialEq, Clone)]
pub enum SqlSegment {
    Query(QueryDetails),
    Fragment(FragmentDetails),
}

pub fn parse_single_query(
    query: &str,
    offset: usize,
    tokens: &Vec<ScanToken>,
    params: &Option<Vec<String>>,
    templates: &Vec<Template>,
    fragments: &HashMap<String, RelocatedFragment>,
) -> Result<(RawStmt, String)> {
    let mut in_prepare = false;

    let mut strings_with_variables: Vec<String> = vec![];
    let mut strings_with_examples: Vec<String> = vec![];
    let mut last_end = None;
    let mut i = 0;

    loop {
        if i >= tokens.len() {
            break;
        }

        let token = &tokens[i];
        i += 1;

        match token.token() {
            Token::WhitespaceP | Token::CComment | Token::SqlComment | Token::Ascii59 => {
                last_end = Some(token.end as usize - offset);
            }
            Token::Ascii58 if (!in_prepare && i < tokens.len()) => {
                let start = tokens[i].start as usize - offset;
                let end = tokens[i].end as usize - offset;
                let name = &query[start..end];

                strings_with_examples.push(" ".to_string());
                strings_with_variables.push(" ".to_string());

                last_end = Some(end);
                i += 1;

                let param_idx = params
                    .as_ref()
                    .iter()
                    .flat_map(|param| param.iter())
                    .position(|param| param == name);

                if let Some(idx) = param_idx {
                    strings_with_examples.push(format!("${}", idx + 1));
                    strings_with_variables.push(format!("${}", idx + 1));
                    continue;
                }

                let x_template = templates.iter().find(|templ| templ.name == name);
                if let Some(tmpl) = x_template {
                    strings_with_examples.push(tmpl.example.clone());

                    strings_with_variables.push(":".to_string());
                    strings_with_variables.push("__tmpl_".to_string());
                    strings_with_variables.push(name.to_string());
                    continue;
                }

                let fragment = fragments.get(name);
                if let Some(frag) = fragment {
                    strings_with_examples.push(frag.contents.clone());
                    strings_with_variables.push(frag.contents.clone());
                    continue;
                }

                strings_with_examples.push(":".to_string());
                strings_with_examples.push(name.to_string());

                strings_with_variables.push(":".to_string());
                strings_with_variables.push(name.to_string());
            }
            tok => {
                if tok == Token::Prepare {
                    in_prepare = true;
                }

                let start = token.start as usize - offset;
                let end = token.end as usize - offset;

                if let Some(val) = last_end {
                    if start > val {
                        strings_with_examples.push(" ".to_string());

                        if !in_prepare {
                            strings_with_variables.push(" ".to_string());
                        }
                    }
                }

                strings_with_examples.push(query[start..end].to_string());

                if !in_prepare {
                    strings_with_variables.push(query[start..end].to_string());
                }

                last_end = Some(end);

                if tok == Token::As {
                    in_prepare = false;
                }
            }
        }
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

    let (query_iter, fragment_iter): (Vec<_>, Vec<_>) = queries
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

            let details = get_details(tokens, query, location as usize, || format!("query_{}", i));

            return Some((location, index_start, index_len, query, details, tokens));
        })
        .partition(|(_, _, _, _, details, _)| match details {
            SqlSegment::Query(_) => true,
            _ => false,
        });

    let mut fragments: HashMap<String, RelocatedFragment> = HashMap::new();
    for (location, index_start, index_len, query, details, tokens) in fragment_iter {
        match details {
            SqlSegment::Query(_) => (),
            SqlSegment::Fragment(details) => {
                let stmt = parse_single_query(
                    query,
                    location as usize,
                    &tokens,
                    &None,
                    &vec![],
                    &fragments,
                );

                let (parsed_stmt, contents) = match stmt {
                    Ok((stmt, templated_query)) => (Ok(stmt), templated_query),
                    Err(e) => (Err(e), query.to_string()),
                };

                fragments.insert(
                    details.name.clone(),
                    RelocatedFragment {
                        stmt: parsed_stmt,
                        range: get_range(index_start, index_len),
                        index_start,
                        index_len,
                        details,
                        contents,
                    },
                );
            }
        };
    }

    let mut queries: Vec<RelocatedQuery> = vec![];
    for (location, index_start, index_len, query, details, tokens) in query_iter {
        match details {
            SqlSegment::Query(mut details) => {
                let stmt = parse_single_query(
                    query,
                    location as usize,
                    tokens,
                    &details.params,
                    &details.templates,
                    &fragments,
                );

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

                queries.push(RelocatedQuery {
                    stmt: parsed_stmt,
                    range: get_range(index_start, index_len),
                    index_start,
                    index_len,
                    details,
                    contents,
                    variables,
                });
            }
            SqlSegment::Fragment(_) => (),
        }
    }

    return Ok(ParsedFile {
        queries,
        fragments,
        tokens,
    });
}

fn parse_comment<F>(string: &String, default_name: F) -> SqlSegment
where
    F: FnOnce() -> String,
{
    let mut raw_attributes: HashMap<&str, Vec<Vec<String>>> = HashMap::new();
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

        let components = trimmed_comment.split_whitespace().collect::<Vec<_>>();

        if let Some(name) = components.get(0) {
            if Some('@') != name.chars().nth(0) {
                comment_lines.push(trimmed_comment.to_string());
                continue;
            }

            let options = components[1..]
                .iter()
                .map(|&s| s.to_string())
                .collect::<Vec<_>>();

            if options.len() == 0 {
                continue;
            }

            if let Some(existing) = raw_attributes.get_mut(name) {
                existing.push(options);
            } else {
                raw_attributes.insert(name, vec![options]);
            }
        }
    }

    if let Some(mut names) = raw_attributes.remove(&"@fragment") {
        let name = names.remove(0).remove(0);

        return SqlSegment::Fragment(FragmentDetails {
            comment: comment_lines.join("\n"),
            name,
        });
    }

    let name = if let Some(mut names) = raw_attributes.remove(&"@name") {
        names.remove(0).remove(0)
    } else {
        default_name()
    };

    let params: Option<Vec<String>> = if let Some(param_list) = raw_attributes.remove(&"@params") {
        let mut acc = vec![];
        for mut param in param_list {
            acc.append(&mut param);
        }

        Some(acc)
    } else {
        None
    };

    let templates: Vec<Template> = if let Some(template_list) = raw_attributes.remove(&"@xtemplate")
    {
        let mut acc = vec![];
        for template in template_list {
            let name = template[0].to_string();
            let example = template[1..].join(" ");
            acc.push(Template { name, example });
        }

        acc
    } else {
        vec![]
    };

    return SqlSegment::Query(QueryDetails {
        comment: comment_lines.join("\n"),
        name,
        params,
        templates,
    });
}

pub fn get_details<F>(
    tokens: &Vec<ScanToken>,
    content: &str,
    offset: usize,
    default_name: F,
) -> SqlSegment
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
