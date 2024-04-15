use crate::{code_builder::codegen_helper::CodegenHelper, query::query::Column};

pub fn format_table_like(builder: &mut CodegenHelper, table_like: &Vec<Column>) {
    for column in table_like.iter() {
        let line = if !column.nullable {
            format!("{} {} NOT NULL", column.name, column.type_name)
        } else {
            format!("{} {}", column.name, column.type_name)
        };

        builder.write_line(Some(&line));
    }
}
