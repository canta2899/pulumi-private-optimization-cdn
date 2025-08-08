#!/bin/bash
set -euo pipefail

# Bundles the Lambda with sharp for image processing
# Usage: ./optimization/bundle.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Bundling Lambda..."

mkdir -p lambda

docker run --rm -v "$SCRIPT_DIR/lambda":/var/task -w /var/task node:22 bash -c "\
  npm init -y >/dev/null && npm i sharp@latest"

cp index.js lambda/index.js

