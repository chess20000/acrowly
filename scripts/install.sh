#!/usr/bin/env bash
set -euo pipefail

echo "=== Acrowly 后端安装与启动 ==="

if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 20+ (https://nodejs.org) 后再运行此脚本。"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "当前 Node.js 版本过低 ($(node -v))，需要 Node.js 20+。"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$TARGET_DIR/package.json" ]; then
  TARGET_DIR="$HOME/.acrowly"
  if [ ! -d "$TARGET_DIR" ]; then
    REPO_URL="${ACROWLY_REPO:-https://github.com/chess20000/acrowly.git}"
    git clone "$REPO_URL" "$TARGET_DIR"
  fi
fi

cd "$TARGET_DIR"
npm install --no-audit --no-fund
npm run build
npm link >/dev/null 2>&1 || true

exec node dist/index.js
