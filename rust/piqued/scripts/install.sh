#!/usr/bin/env bash

set -e

if [[ "$(arch)" == "arm64" ]]; then
    ARCH="aarch64"
elif [[ "$(arch)" == "x86_64" ]]; then
    ARCH="x86_64"
else
    echo "Unsupported architecture: $(arch)"
    exit 1
fi

if [[ "$(uname)" == "Darwin" ]]; then
    OS="apple-darwin"
elif [[ "$(uname)" == "Linux" ]]; then
    OS="unknown-linux-gnu"
else
    echo "Unsupported OS: $(uname)"
    exit 1
fi

function get_file() {
    BASE_NAME=$1

    FILE_NAME="${BASE_NAME}.${ARCH}-${OS}"

    SCRIPT=$(cat <<EOF
const fs = require("fs");

const FILE_NAME = "${FILE_NAME}";
const input = JSON.parse(fs.readFileSync(0, "utf8"));

for (const asset of input.assets) {
    if (asset.name === FILE_NAME) {
        console.log(asset.url);
        process.exit(0);
    }
}

process.exit(1);
EOF
)

    ASSET_URL=$(curl --request GET \
        --url https://api.github.com/repos/zwade/piqued/releases/latest \
        -Ss \
        --header 'Accept: application/vnd.github+json' \
        | node -e "$SCRIPT"
    )

    if [[ $? -ne 0 ]]; then
        echo "Failed to find asset for ${FILE_NAME}"
        exit 1
    fi

    echo "Downloaded a new version of ${BASE_NAME} from ${ASSET_URL}"

    TMPFILE=$(mktemp)

    curl --request GET \
    --url "${ASSET_URL}" \
    --header 'Accept: application/octet-stream' \
    -Ss \
    -L \
    --output "${TMPFILE}"

    chmod +x "${TMPFILE}"

    echo "Installing to /usr/local/bin/${BASE_NAME}"

    mv "${TMPFILE}" /usr/local/bin/${BASE_NAME} 2>/dev/null || sudo mv "${TMPFILE}" /usr/local/bin/${BASE_NAME}
}

get_file piqued
get_file piqued_lsp