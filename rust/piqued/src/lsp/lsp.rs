use std::sync::Arc;

use tokio::sync::{MappedMutexGuard, Mutex, MutexGuard};
use tokio_postgres::config;
use tower_lsp::jsonrpc;
use tower_lsp::lsp_types::{
    DidChangeTextDocumentParams, DidOpenTextDocumentParams, Hover, HoverParams,
    HoverProviderCapability, InitializeParams, InitializeResult, InitializedParams, MessageType,
    ServerCapabilities, TextDocumentSyncCapability, TextDocumentSyncKind, Url,
};
use tower_lsp::{Client, LanguageServer};

use crate::config::config::Config;
use crate::workspace::workspace::Workspace;

#[derive(Debug)]
pub struct Backend {
    pub client: Client,
    workspaces: Mutex<Vec<Workspace>>,
}

impl Backend {
    pub fn new(client: Client) -> Self {
        Backend {
            client,
            workspaces: Mutex::new(Vec::new()),
        }
    }

    async fn workspace_for_file(&self, file_uri: &Url) -> Option<MappedMutexGuard<'_, Workspace>> {
        if let Ok(file_name) = file_uri.to_file_path() {
            let workspace_index = self
                .workspaces
                .lock()
                .await
                .iter()
                .position(|workspace| workspace.contains_file(&file_name))?;

            let workspaces = self.workspaces.lock().await;
            let result = MutexGuard::map(workspaces, |workspaces| &mut workspaces[workspace_index]);

            Some(result)
        } else {
            // If there's only one workspace, we can naively assume we want to use it.
            let workspace_size = self.workspaces.lock().await.len();
            if workspace_size == 1 {
                let workspaces = self.workspaces.lock().await;
                let result = MutexGuard::map(workspaces, |workspaces| &mut workspaces[0]);

                Some(result)
            } else {
                None
            }
        }
    }

    pub async fn run_diagnostics(&self, workspace: &Workspace, uri: Url) {
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
                if config_path.is_none() {
                    // We don't bother setting up an LSP if there's no active config
                    continue;
                }

                let config = Config::load(&config_path, &root_dir).await;

                if let Err(err) = config {
                    self.client
                        .log_message(MessageType::ERROR, format!("{:#?}", err))
                        .await;
                    continue;
                }

                self.client
                    .log_message(
                        MessageType::INFO,
                        format!(
                            "Added workspace at {:?}, with config: {:?}",
                            root_dir.clone(),
                            config.clone()
                        ),
                    )
                    .await;

                let config = config.unwrap();
                let workspace = Workspace::new(Arc::new(config), root_dir).await;
                workspaces.push(workspace);
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

        let mut workspace = match maybe_workspace {
            Some(workspace) => workspace,
            None => return (),
        };

        let uri = params.text_document.uri.clone();

        workspace.patch_file(uri.to_string(), params.text_document.text.clone());

        self.run_diagnostics(&workspace, params.text_document.uri)
            .await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let maybe_workspace = self.workspace_for_file(&params.text_document.uri).await;

        let mut workspace = match maybe_workspace {
            Some(workspace) => workspace,
            None => return (),
        };

        workspace.patch_file(
            params.text_document.uri.to_string(),
            params.content_changes[0].text.clone(),
        );

        self.run_diagnostics(&workspace, params.text_document.uri)
            .await;
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

        let maybe_workspace = self
            .workspace_for_file(&params.text_document_position_params.text_document.uri)
            .await;

        let workspace = match maybe_workspace {
            Some(workspace) => workspace,
            None => return Ok(None),
        };

        let file_data = match workspace.get_file(&file_name) {
            Some(data) => data,
            None => {
                self.client
                    .log_message(MessageType::ERROR, "File not found")
                    .await;
                return Ok(None);
            }
        };

        match self.get_hover_data(&workspace, file_data, &position).await {
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
