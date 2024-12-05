use tower_lsp::lsp_types::{Hover, HoverContents, LanguageString, MarkedString};

use crate::{
    code_builder::codegen_helper::CodegenHelper, query::query::Column,
    workspace::workspace::Workspace,
};

fn format_table_like(workspace: &Workspace, builder: &mut CodegenHelper, table_like: &Vec<Column>) {
    let query_obj = workspace.query.as_ref().unwrap();

    for column in table_like.iter() {
        let line = if !column.nullable {
            format!("{} {} NOT NULL", column.name, column.type_name)
        } else {
            format!("{} {}", column.name, query_obj.get_column_type(column))
        };

        builder.write_line(Some(&line));
    }
}

pub fn format_table(workspace: &Workspace, name: &str, table_data: &Vec<Column>) -> Hover {
    let mut builder = CodegenHelper::new(&"  ", "\n");

    builder.write_line(Some(&format!("{} (", name)));
    builder.with_indent(|mut builder| {
        format_table_like(workspace, &mut builder, table_data);
    });
    builder.write_line(Some(&")"));

    Hover {
        contents: HoverContents::Array(vec![
            MarkedString::LanguageString(LanguageString {
                language: "pgsql".to_string(),
                value: "(table)".to_string(),
            }),
            MarkedString::LanguageString(LanguageString {
                language: "pgsql".to_string(),
                value: builder.serialize(),
            }),
        ]),
        range: None,
    }
}

pub fn format_column(workspace: &Workspace, name: &str, column: &Column) -> Hover {
    let mut builder = CodegenHelper::new(&"  ", "\n");
    let query_obj = workspace.query.as_ref().unwrap();

    builder.write(name);
    builder.write_symbol(".");
    builder.write_token(&column.name);
    builder.write_token(&query_obj.get_column_type(column));

    if !column.nullable {
        builder.write_token("NOT NULL");
    }

    Hover {
        contents: HoverContents::Array(vec![
            MarkedString::LanguageString(LanguageString {
                language: "pgsql".to_string(),
                value: "(column)".to_string(),
            }),
            MarkedString::LanguageString(LanguageString {
                language: "pgsql".to_string(),
                value: builder.serialize(),
            }),
        ]),
        range: None,
    }
}

pub fn format_debug(workspace: &Workspace, contents: &str) -> Hover {
    Hover {
        contents: HoverContents::Array(vec![
            MarkedString::LanguageString(LanguageString {
                language: "pgsql".to_string(),
                value: "(debug)".to_string(),
            }),
            MarkedString::LanguageString(LanguageString {
                language: "pgsql".to_string(),
                value: contents.to_string(),
            }),
        ]),
        range: None,
    }
}
