#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ -x "runtime/node" ]]; then
  exec runtime/node scripts/local-ui.mjs
elif command -v node >/dev/null 2>&1; then
  exec node scripts/local-ui.mjs
else
  printf 'Node.js 20 or later is required. Install it, then run this launcher again.\n'
  read -r -p 'Press Return to close.'
fi
