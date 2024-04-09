use std::collections::HashMap;

use tokio::sync::{MappedMutexGuard, Mutex, MutexGuard};
use tower_lsp::jsonrpc;
use tower_lsp::lsp_types::{
    DidChangeTextDocumentParams, DidOpenTextDocumentParams, Hover, HoverParams,
    HoverProviderCapability, InitializeParams, InitializeResult, InitializedParams, MessageType,
    ServerCapabilities, TextDocumentSyncCapability, TextDocumentSyncKind, Url,
};
use tower_lsp::{Client, LanguageServer};

use crate::config::config::Config;
use crate::query::query::Query;
use crate::workspace::workspace::Workspace;

#[derive(Debug)]
pub struct Backend {
    pub client: Client,
    pub query: Query<'static>,
    workspaces: Mutex<Vec<Workspace<'static>>>,
}

impl Backend {
    pub fn new(client: Client, query: Query<'static>) -> Self {
        Backend {
            client,
            query,
            workspaces: Mutex::new(Vec::new()),
        }
    }

    async fn workspace_for_file(
        &self,
        file_uri: &Url,
    ) -> Option<MappedMutexGuard<'_, Workspace<'static>>> {
        let file_name = file_uri.to_file_path().unwrap();

        let workspace_index = self
            .workspaces
            .lock()
            .await
            .iter()
            .position(|workspace| workspace.contains_file(&file_name))?;

        let workspaces = self.workspaces.lock().await;
        let result = MutexGuard::map(workspaces, |workspaces| &mut workspaces[workspace_index]);

        Some(result)
    }

    pub async fn run_diagnostics(&self, uri: Url) {
        let maybe_workspace = self.workspace_for_file(&uri).await;

        let workspace = match maybe_workspace {
            Some(workspace) => workspace,
            None => return (),
        };

        let diagnostics = workspace.get_diagnostics(uri.as_str()).await;

        match diagnostics {
            Ok(diagnostics) => {
                self.client
                    .publish_diagnostics(uri, diagnostics, None)
                    .await;
            }
            Err(e) => {
                self.client
                    .log_message(MessageType::ERROR, e.to_string())
                    .await;
            }
        }
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, params: InitializeParams) -> jsonrpc::Result<InitializeResult> {
        let mut workspaces = vec![];

        if let Some(folders) = params.workspace_folders {
            for folder in folders {
                let root_dir = folder.uri.to_file_path().unwrap();
                let config_path = Config::find_dir(&root_dir).await;
                let config = Config::load(&config_path, &root_dir).await;

                if let Err(err) = config {
                    self.client
                        .log_message(MessageType::ERROR, format!("{:#?}", err))
                        .await;
                    continue;
                }

                let mut workspace = Workspace::new(&config.unwrap(), root_dir).await;
                // workspace.reload().await;
                workspaces.push(workspace)
            }
        }

        self.workspaces.lock().await.extend(workspaces);

        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                ..Default::default()
            },
            ..Default::default()
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "Server Initialized!")
            .await;
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        self.client
            .log_message(MessageType::INFO, format!("Document Opened: {:#?}", params))
            .await;

        let maybe_workspace = self.workspace_for_file(&params.text_document.uri).await;

        let workspace = match maybe_workspace {
            Some(workspace) => workspace,
            None => return (),
        };

        workspace.patch_file(
            &params.text_document.uri.as_str(),
            &params.text_document.text,
        );

        self.run_diagnostics(params.text_document.uri).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        self.client
            .log_message(MessageType::INFO, format!("Did change: {:#?}", params))
            .await;

        let maybe_workspace = self.workspace_for_file(&params.text_document.uri).await;

        let workspace = match maybe_workspace {
            Some(workspace) => workspace,
            None => return (),
        };

        workspace.patch_file(
            &params.text_document.uri.as_str(),
            &params.content_changes[0].text,
        );

        self.run_diagnostics(params.text_document.uri).await;
    }

    async fn shutdown(&self) -> jsonrpc::Result<()> {
        Ok(())
    }

    async fn hover(&self, params: HoverParams) -> jsonrpc::Result<Option<Hover>> {
        let position = params.text_document_position_params.position;
        let file_name = params
            .text_document_position_params
            .text_document
            .uri
            .to_string();

        let cache = self.file_cache.try_lock().unwrap();
        let file_data = cache.get(&file_name);

        match self.get_hover_data(file_data, &position).await {
            Err(e) => {
                self.client
                    .log_message(MessageType::ERROR, format!("{:#?}", e))
                    .await;
                Ok(None)
            }
            Ok(hov) => Ok(Some(hov)),
        }
    }
}
