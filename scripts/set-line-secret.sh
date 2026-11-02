#!/bin/bash
# LINE と Claude の鍵を、自分の AWS の Secrets Manager に保存する（入力は画面に表示しない）。
#   LINE_CHANNEL_SECRET       : LINE Developers → チャネル基本設定 →「チャネルシークレット」
#   LINE_CHANNEL_ACCESS_TOKEN : LINE Developers → Messaging API設定 →「チャネルアクセストークン（長期）」
#   ANTHROPIC_API_KEY         : Claude の API キー（sk-ant-…）
# 空のまま Enter を押した項目は、今の値を残す。使い方: bash scripts/set-line-secret.sh
set -euo pipefail
REGION=ap-northeast-1
ARN=$(aws cloudformation describe-stacks --stack-name dr-baito-bot --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue" --output text)
# Claude Code の「!」から実行すると入力を受け付けられないので、そのときは macOS の入力ダイアログ（伏せ字）で聞く
ask() {
  if [ -t 0 ]; then read -rsp "$1: " v; echo >&2; printf '%s' "$v"
  else osascript -e "text returned of (display dialog \"$1 を貼り付けてください（空欄なら今の値のまま）\" default answer \"\" with hidden answer with title \"医師バイト秘書\")" 2>/dev/null || true
  fi
}
LS=$(ask "チャネルシークレット")
LT=$(ask "チャネルアクセストークン（長期）")
AK=$(ask "Claude の API キー")
TMP=$(mktemp); CUR=$(mktemp); trap 'rm -f "$TMP" "$CUR"' EXIT
aws secretsmanager get-secret-value --region $REGION --secret-id "$ARN" --query SecretString --output text > "$CUR"
CUR_FILE="$CUR" LS="$LS" LT="$LT" AK="$AK" node -e '
  const fs = require("fs");
  const cur = JSON.parse(fs.readFileSync(process.env.CUR_FILE, "utf8") || "{}");
  const set = (k, v) => { if (v) cur[k] = v.trim(); };
  set("LINE_CHANNEL_SECRET", process.env.LS); set("LINE_CHANNEL_ACCESS_TOKEN", process.env.LT); set("ANTHROPIC_API_KEY", process.env.AK);
  process.stdout.write(JSON.stringify(cur));
' > "$TMP"
aws secretsmanager put-secret-value --region $REGION --secret-id "$ARN" --secret-string "file://$TMP" >/dev/null
echo "✔ 保存しました（入れた項目: $( [ -n "$LS" ] && printf "シークレット " )$( [ -n "$LT" ] && printf "トークン " )$( [ -n "$AK" ] && printf "Claudeキー" )）。5分以内に反映されます"
