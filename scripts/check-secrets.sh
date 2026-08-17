#!/usr/bin/env bash
# 提交前自查：源码与文档里不应出现真实密钥。
# 测试与文档中的示例密钥必须带 fake / smoke / fixture / example 字样，
# 这个脚本据此区分「示例」与「事故」。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PATTERN='sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|xox[bpars]-[0-9A-Za-z-]{10,}'
SAFE='fake|smoke|fixture|example|test|real-secret|abcdefghij|MASKED|xxxx'

hits=$(grep -rEn "$PATTERN" \
        --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.md' \
        --include='*.sh' --include='*.yml' --include='*.json' --include='*.html' \
        --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=out \
        --exclude-dir=dist --exclude-dir=.issues --exclude=pnpm-lock.yaml . 2>/dev/null \
      | grep -vEi "$SAFE" || true)

if [ -n "$hits" ]; then
  echo "发现疑似真实密钥，提交前请处理："
  echo "$hits"
  exit 1
fi
echo "未发现疑似真实密钥。"
