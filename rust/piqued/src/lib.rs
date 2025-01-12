#![feature(try_trait_v2, pattern)]

pub mod parser {
    pub mod parser;
}
pub mod lsp {
    mod backend;
    mod formatters;
    pub mod lsp;
}
pub mod query {
    pub mod query;
}
pub mod config {
    pub mod config;
}
pub mod codegen {
    pub mod codegen;
    pub mod utils;
    pub mod ts {
        pub mod schema;
    }
}
pub mod loose_parser {
    pub mod operators;
    pub mod parse;
    pub mod parse_cf;
}
pub mod code_builder {
    pub mod codegen_helper;
}

pub mod workspace {
    pub mod workspace;
}

mod utils {
    pub mod result;
}
