use std::collections::HashMap;

use tokio::sync::Mutex;
use tower_lsp::jsonrpc;
use tower_lsp::lsp_types::{TextDocumentSyncKind, TextDocumentSyncCapability, HoverProviderCapability, ServerCapabilities, InitializeResult, InitializeParams, InitializedParams, HoverParams, Hover, MessageType, DidChangeTextDocumentParams, DidOpenTextDocumentParams, Url};
use tower_lsp::{Client, LanguageServer};

use crate::query::query::Query;
use crate::lsp::utils;

use super::utils::get_diagnostics;

#[derive(Debug)]
pub struct Backend {
    pub client: Client,
    pub query: Query<'static>,
    file_cache: Mutex<HashMap<String, String>>,
}

impl Backend {
    pub fn new(client: Client, query: Query<'static>) -> Self {
        Backend {
            client,
            query,
            file_cache: Mutex::new(HashMap::new()),
        }
    }

    pub async fn run_diagnostics(&self, uri: Url) {
        let file_cache = self.file_cache.lock().await;
        let file = file_cache.get(&uri.to_string());
        let diagnostics = get_diagnostics(self, file).await;

        match diagnostics {
            Ok(diagnostics) => {
                self.client.publish_diagnostics(uri, diagnostics, None).await;
            },
            Err(e) => {
                self.client.log_message(MessageType::ERROR, e.to_string()).await;
            }
        }
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, _: InitializeParams) -> jsonrpc::Result<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
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

        self.file_cache.try_lock().unwrap().insert(params.text_document.uri.to_string(), params.text_document.text);
        self.run_diagnostics(params.text_document.uri).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        self.client
            .log_message(MessageType::INFO, format!("Did change: {:#?}", params))
            .await;

        self.file_cache.try_lock().unwrap().insert(params.text_document.uri.to_string(), params.content_changes[0].text.clone());
        self.run_diagnostics(params.text_document.uri).await;
    }

    async fn shutdown(&self) -> jsonrpc::Result<()> {
        Ok(())
    }

    async fn hover(&self, params: HoverParams) -> jsonrpc::Result<Option<Hover>> {
        let position = params.text_document_position_params.position;
        let file_name = params.text_document_position_params.text_document.uri.to_string();

        let cache = self.file_cache.try_lock().unwrap();
        let file_data = cache.get(&file_name);

        match utils::get_hover_data(self, file_data, &position).await {
            Err(e) => {
                self.client.log_message(MessageType::ERROR, format!("{:#?}", e)).await;
                Ok(None)
            },
            Ok(hov) => {
                Ok(Some(hov))
            }
        }
    }
}
