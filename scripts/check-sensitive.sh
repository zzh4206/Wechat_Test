#!/usr/bin/env bash
# 敏感信息防线：命中真实标识符 / 群 ID / 家目录路径 / 密钥模式即失败（exit 1）。
#
# 背景：本仓库曾两次把真实标识符写进公开内容（src/index.ts 的 wxid、
# docs/REPORT-db-access.md 的账号目录），历史已由 git filter-repo 清理。
# 本脚本是防止第三次发生的补偿控制，由 CI 的 sensitive-scan job 强制执行。
#
# 规则：真实值一律用占位符（wxid_xxx / wxid_a / 12345678@chatroom / $HOME/...）。
# 白名单只放**合成值**；任何以真实 wxid 前缀开头但不等于白名单条目的值都会被拦下。

set -euo pipefail

# 真实标识符、群 ID、家目录路径、常见密钥形态
PATTERN='wxid_[A-Za-z0-9_]{8,}|[0-9]{8,}@chatroom|/Users/[A-Za-z0-9_.-]+|sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9._-]{20,}|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}'

# 合成值白名单。末尾的 \b 必须保留：没有它 `wxid_b` 会连同任何以 `wxid_b` 开头的
# 真实 wxid（形如 `wxid_b********`）一起被放行，造成静默漏报。
# 注意：本文件自身也在扫描范围内，所以这里不能写任何完整示例值——只能写前缀加掩码。
ALLOW='wxid_xxx|wxid_yyy|wxid_me|wxid_hash|wxid_zhang111|wxid_li222|wxid_twin999|wxid_boss001|wxid_(a|b|c|d|e|x|z|s|self|bob|alice|boss|other|stranger|raw|old|new|wanglei|liqiang|zhangsan|liumin|chenjing|liuyang|zhaoPeng)[0-9]*\b|12345678@chatroom|1234567890@chatroom|/Users/<'

if grep -rInE "$PATTERN" . \
     --exclude-dir=.git \
     --exclude-dir=node_modules \
     --exclude-dir=lib \
     --exclude-dir=state \
     --exclude-dir=spikes \
     --exclude-dir=sec-tests \
     --exclude-dir=.npm-cache \
   | grep -vE "$ALLOW"; then
  echo "" >&2
  echo "❌ 发现疑似敏感信息（真实 wxid / 群 ID / 家目录路径 / 密钥）。" >&2
  echo "   请把命中行的真实值改为占位符后再提交：wxid_xxx、12345678@chatroom、\$HOME/...。" >&2
  echo "   本地真实值请放 DSH profile 的 cordis.patch.yml 或未跟踪的 cordis.local.yml。" >&2
  exit 1
fi

echo "✅ 敏感信息扫描通过：未发现真实标识符、家目录路径或密钥模式"
