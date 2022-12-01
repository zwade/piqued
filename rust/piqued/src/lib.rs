#![feature(try_trait_v2)]

pub mod parser {
    pub mod parser;
}
pub mod lsp {
    pub mod lsp;
    mod utils;
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
    pub mod parse;
    pub mod parse_cf;
}
