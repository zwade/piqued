use piqued::{lsp::lsp::{Backend}, query::query::Query};
use tower_lsp::{LspService,Server};

#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let query = Query::new().await.unwrap();
    let (service, socket) = LspService::new(|client| Backend::new(client, query));

    Server::new(stdin, stdout, socket).serve(service).await;
}