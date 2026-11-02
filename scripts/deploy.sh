#!/bin/bash
# ビルドしてデプロイする。設定は samconfig.toml、求人データの URL などは --parameter-overrides で渡す。
#   例: bash scripts/deploy.sh "JobsFeedUrl=https://api.example.com/doctor-jobs JobHosts=jobs.example.com,app.example.com"
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/node_modules/.bin:$PATH" # sam build が esbuild を見つけられるように
sam build
if [ -n "${1:-}" ]; then sam deploy --parameter-overrides "$1"; else sam deploy; fi
