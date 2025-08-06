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
    parser::parser::{self, RelocatedStmt},
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

pub struct QueryContext(pub RelocatedStmt, pub ProbeResponse);

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

    fn serialize_table_prefix(
        &self,
        _ctx: &CodeGenerationContext,
        _tables: &Vec<&String>,
    ) -> Option<String> {
        None
    }
    fn serialize_table(&self, _ctx: &CodeGenerationContext, _table: &String)
        -> SerializationResult;
    fn serialize_table_suffix(
        &self,
        _ctx: &CodeGenerationContext,
        _tables: &Vec<&String>,
    ) -> Option<String> {
        None
    }
}

pub struct CodeGenerationContext<'a> {
    pub config: Arc<Config>,
    pub working_dir: PathBuf,
    pub query: &'a Query,
}

pub struct CodeGenerationOptions {
    pub comparison_only: bool,
}

impl<'a> CodeGenerationContext<'a> {
    pub fn new(config: Arc<Config>, query: &'a Query) -> CodeGenerationContext<'a> {
        let working_dir = config.workspace.root.as_ref().unwrap().clone();

        CodeGenerationContext {
            working_dir,
            config: config.clone(),
            query,
        }
    }

    pub async fn generate_system_types(
        &self,
        generator: &dyn CodeGenerator,
        options: &CodeGenerationOptions,
    ) -> bool {
        let mut b = Builder::default();
        let mut imports: Vec<String> = vec![];

        let mut all_types = self
            .query
            .custom_types_by_name
            .values()
            .into_iter()
            .map(|refrence| refrence.clone())
            .collect::<Vec<Arc<CustomType>>>();
        all_types.sort();

        if let Some(prefix) = generator.serialize_type_prefix(self, &all_types) {
            b.append(prefix.as_bytes());
        }

        b.append("\n");

        let mut type_names = self.query.custom_types_by_name.values().collect::<Vec<_>>();
        type_names.sort();

        for type_ in type_names {
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

        let produced_file = b.string().unwrap();
        let existing = fs::read_to_string(source_path.clone())
            .await
            .unwrap_or_default();

        if produced_file != existing {
            if options.comparison_only {
                println!("Changes detected to system types.");

                return false;
            } else {
                fs::write(source_path.clone(), produced_file).await.unwrap();
            }
        }

        true
    }

    pub async fn generate_table_file(
        &self,
        generator: &dyn CodeGenerator,
        options: &CodeGenerationOptions,
    ) -> bool {
        let table_file = match &self.config.emit.table_file {
            Some(table_file) => table_file,
            None => return true,
        };

        let mut code_segments: Vec<String> = vec![];
        let mut imports: Vec<String> = vec![];

        let mut tables = self.query.tables.keys().into_iter().collect::<Vec<_>>();
        tables.sort();

        if let Some(prefix) = generator.serialize_table_prefix(&self, &tables) {
            code_segments.push(prefix);
        }

        for table_name in &tables {
            let res = generator.serialize_table(&self, table_name);
            imports.extend(res.requires_import);
            code_segments.push(res.generated_code);
        }

        if let Some(suffix) = generator.serialize_table_suffix(&self, &tables) {
            code_segments.push(suffix);
        }

        let mut b = Builder::default();

        let base_path = self.working_dir.join(&table_file);
        let source_path = generator.resolve_file_path(self, &base_path);

        b.append(self.generate_import_statements(
            &PathBuf::from(source_path.clone()),
            &imports,
            generator,
        ));

        for chunk in code_segments {
            b.append(chunk);
        }

        let produced_file = b.string().unwrap();
        let existing = fs::read_to_string(source_path.clone())
            .await
            .unwrap_or_default();

        if produced_file != existing {
            if options.comparison_only {
                println!("Changes detected to table file.");

                return false;
            } else {
                fs::write(source_path, produced_file).await.unwrap();
            }
        }

        true
    }

    pub async fn generate_queries(
        &self,
        generator: &dyn CodeGenerator,
        options: &CodeGenerationOptions,
    ) -> bool {
        let query_files = self.locate_query_files().await;
        let mut overall_success = true;

        for query_file in query_files {
            let mut dst_file = query_file.clone();
            dst_file.set_extension("ts");

            let success = self
                .generate_query_file(generator, &query_file, &dst_file, options)
                .await;

            if !success {
                overall_success = false;
            }
        }

        overall_success
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

        walk_dir(&self.working_dir, &mut files).await;
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
        options: &CodeGenerationOptions,
    ) -> bool {
        let contents = fs::read_to_string(src_file).await.unwrap();
        let data = parser::load_file(&contents);

        let mut imports: Vec<String> = vec![];
        let mut code_segments: Vec<String> = vec![];

        let statements = match data {
            Ok(data) => {
                let mut results = vec![];
                for stmt in data.statements.into_iter() {
                    let probed_type = self.query.probe_type(&stmt).await.unwrap();

                    results.push(QueryContext(stmt, probed_type))
                }

                results
            }

            Err(e) => {
                println!("Error: {:#?}", e);
                return false;
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

        let mut b = Builder::default();

        b.append(self.generate_import_statements(&dst_file, &imports, generator));

        for segment in code_segments {
            b.append(segment);
            b.append("\n\n");
        }

        let produced_file = b.string().unwrap();
        let existing = fs::read_to_string(dst_file.clone())
            .await
            .unwrap_or_default();

        if produced_file != existing {
            if options.comparison_only {
                println!("Changes detected to query file: {}", src_file.display());
                return false;
            } else {
                fs::write(dst_file, produced_file).await.unwrap();
            }
        }

        true
    }

    fn generate_import_statements(
        &self,
        dst_file: &PathBuf,
        imports: &Vec<String>,
        generator: &dyn CodeGenerator,
    ) -> String {
        let mut b = Builder::default();

        let mut needed_imports = imports
            .into_iter()
            .collect::<HashSet<&String>>()
            .into_iter()
            .map(|s| s.clone())
            .collect::<Vec<String>>();
        needed_imports.sort();

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

        return b.string().unwrap();
    }
}
