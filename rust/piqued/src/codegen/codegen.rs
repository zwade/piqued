use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_recursion::async_recursion;
use string_builder::Builder;
use tokio::fs;

use crate::{
    config::config::Config,
    parser::parser::{self, ParsedPreparedQuery},
    query::query::{CustomType, ProbeResponse, Query},
};

pub struct ImportResult {
    pub generated_code: String,
}

pub struct SerializationResult {
    pub generated_code: String,
    pub identifier: String,
    pub requires_import: Vec<String>,
}

pub struct QueryContext(pub ParsedPreparedQuery, pub ProbeResponse);

pub trait CodeGenerator {
    fn serialize_import(
        &self,
        ctx: &CodeGenerationContext,
        path: &PathBuf,
        identifiers: &Vec<String>,
    ) -> ImportResult;
    fn resolve_file_path(&self, ctx: &CodeGenerationContext, path: &PathBuf) -> String;

    fn serialize_type_prefix(
        &self,
        _ctx: &CodeGenerationContext,
        _types: &Vec<Arc<CustomType>>,
    ) -> Option<String> {
        None
    }
    fn serialize_type(
        &self,
        ctx: &CodeGenerationContext,
        type_: &CustomType,
    ) -> SerializationResult;
    fn serialize_type_suffix(
        &self,
        _ctx: &CodeGenerationContext,
        _types: &Vec<Arc<CustomType>>,
    ) -> Option<String> {
        None
    }

    fn serialize_query_prefix(
        &self,
        _ctx: &CodeGenerationContext,
        _queries: &Vec<QueryContext>,
    ) -> Option<String> {
        None
    }
    fn serialize_query(
        &self,
        ctx: &CodeGenerationContext,
        query: &QueryContext,
    ) -> SerializationResult;
    fn serialize_query_suffix(
        &self,
        _ctx: &CodeGenerationContext,
        _queries: &Vec<QueryContext>,
    ) -> Option<String> {
        None
    }
}

pub struct CodeGenerationContext<'a> {
    pub config: &'a Config,
    pub working_dir: &'a Path,
    pub query: Query<'a>,
}

impl<'a> CodeGenerationContext<'a> {
    pub async fn new(working_dir: &'a Path, config: &'a Config) -> CodeGenerationContext<'a> {
        let query = Query::new(config).await;

        CodeGenerationContext {
            working_dir,
            config,
            query: query.unwrap(),
        }
    }

    pub async fn generate_system_types(&self, generator: &dyn CodeGenerator) -> () {
        let mut b = Builder::default();
        let mut imports: Vec<String> = vec![];

        let all_types = self
            .query
            .custom_types_by_name
            .values()
            .into_iter()
            .map(|refrence| refrence.clone())
            .collect::<Vec<Arc<CustomType>>>();

        if let Some(prefix) = generator.serialize_type_prefix(self, &all_types) {
            b.append(prefix.as_bytes());
        }

        b.append("\n");

        for type_ in self.query.custom_types_by_name.values() {
            let res = generator.serialize_type(self, type_);
            b.append(res.generated_code);
            b.append("\n\n");
            imports.extend(res.requires_import);
        }

        if let Some(prefix) = generator.serialize_type_suffix(self, &all_types) {
            b.append(prefix.as_bytes());
        }

        let base_path = self.get_root_path();
        let source_path = generator.resolve_file_path(self, &base_path);

        fs::write(source_path, b.string().unwrap()).await.unwrap();
    }

    pub async fn generate_queries(&self, generator: &dyn CodeGenerator) -> () {
        let query_files = self.locate_query_files().await;

        for query_file in query_files {
            let mut dst_file = query_file.clone();
            dst_file.set_extension("ts");

            self.generate_query_file(generator, &query_file, &dst_file)
                .await;
        }
    }

    async fn locate_query_files(&self) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = vec![];

        #[async_recursion]
        async fn walk_dir(dir: &Path, file_results: &mut Vec<PathBuf>) {
            let mut files = fs::read_dir(dir).await.unwrap();

            while let Ok(Some(entry)) = files.next_entry().await {
                let path = entry.path();

                if path.is_dir() {
                    walk_dir(path.as_path(), file_results).await;
                }

                match path.extension() {
                    Some(ext) => {
                        if ext == "sql" || ext == "psql" || ext == "pgsql" || ext == "pg" {
                            file_results.push(path);
                        }
                    }
                    _ => (),
                }
            }
        }

        walk_dir(self.working_dir, &mut files).await;
        files
    }

    fn get_root_path(&self) -> PathBuf {
        self.working_dir.join(&self.config.emit.type_file)
    }

    async fn generate_query_file(
        &self,
        generator: &dyn CodeGenerator,
        src_file: &PathBuf,
        dst_file: &PathBuf,
    ) {
        let contents = fs::read_to_string(src_file).await.unwrap();
        let data = parser::load_file(&contents);

        let mut imports: Vec<String> = vec![];
        let mut code_segments: Vec<String> = vec![];

        let statements = match data {
            Ok(data) => {
                let mut results = vec![];
                for (i, stmt) in data.statements.iter().enumerate() {
                    let prep_result =
                        parser::get_prepared_statement(&stmt, &data.tokens, &contents, || {
                            format!("query_{i}")
                        });

                    if let Ok(prepared_statement) = prep_result {
                        let probed_type = self.query.probe_type(&prepared_statement).await.unwrap();

                        results.push(QueryContext(prepared_statement, probed_type))
                    }
                }

                results
            }

            Err(e) => {
                println!("Error: {:#?}", e);
                return;
            }
        };

        if let Some(prefix) = generator.serialize_query_prefix(self, &statements) {
            code_segments.push(prefix);
        }

        for stmt in &statements {
            let res = generator.serialize_query(self, stmt);
            imports.extend(res.requires_import);
            code_segments.push(res.generated_code);
        }

        if let Some(suffix) = generator.serialize_query_suffix(self, &statements) {
            code_segments.push(suffix);
        }

        let needed_imports = imports
            .into_iter()
            .collect::<HashSet<String>>()
            .into_iter()
            .collect::<Vec<String>>();

        let mut b = Builder::default();

        let type_file_path = self.working_dir.join(&self.config.emit.type_file);
        let mut start_file_path = dst_file.clone();
        start_file_path.pop();

        let mut relative_path = pathdiff::diff_paths(type_file_path, start_file_path).unwrap();
        if !relative_path.starts_with("../") {
            relative_path = Path::new("./").join(relative_path);
        }

        let import = generator.serialize_import(self, &relative_path, &needed_imports);

        b.append(import.generated_code);
        b.append("\n\n");

        for segment in code_segments {
            b.append(segment);
            b.append("\n\n");
        }

        fs::write(dst_file, b.string().unwrap()).await.unwrap();
    }
}
