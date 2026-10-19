#!/bin/bash
set -euo pipefail
application_path="${1:-/Applications/ProtoPie.app}"
if pgrep -x ProtoPie >/dev/null 2>&1; then
  printf 'Save your Pies and quit ProtoPie, then run this launcher again.\n'
  exit 1
fi
if [[ ! -x "$application_path/Contents/MacOS/ProtoPie" ]]; then
  printf 'ProtoPie was not found at %s\n' "$application_path"
  exit 1
fi
printf 'Automatic approval applies to ALL local Studio MCP clients for this process.\nLaunch Studio normally to return to manual approval.\n'
exec env PROTOPIE_MCP_AUTO_APPROVE=1 "$application_path/Contents/MacOS/ProtoPie"
