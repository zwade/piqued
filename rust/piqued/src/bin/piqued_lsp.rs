use piqued::{config::config::Config, lsp::lsp::Backend, query::query::Query};
use tower_lsp::{LspService, Server};

#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let config = Config::load(None).await.unwrap();
    let leaked: &'static Config = Box::leak(Box::new(config));

    let query = Query::new(leaked).await.unwrap();
    let (service, socket) = LspService::new(|client| Backend::new(client, query));

    Server::new(stdin, stdout, socket).serve(service).await;
}
