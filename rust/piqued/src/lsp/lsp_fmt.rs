use crate::{code_builder::code_builder::CodeBuilder, query::query::Column};

pub fn format_table_like(builder: &mut CodeBuilder, table_like: &Vec<Column>) {
    for column in table_like.iter() {
        builder.writeln(format!("{} {}", column.name, column.type_name));
    }
}
