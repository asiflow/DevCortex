#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DevCortex 45-second demo — "your AI agent said done. did it actually work?"
#
# Real, runnable, no mocks: it creates a throwaway repo where the agent "fixed"
# a bug and declared done, runs the DevCortex ship gate (NOT_READY — the test
# actually fails), fixes the root cause, and ships again (READY).
#
#   bash demo/demo.sh
# ---------------------------------------------------------------------------
set -euo pipefail

# Resolve the CLI: an installed `devcortex` if present, else this repo's build.
if command -v devcortex >/dev/null 2>&1; then
  DC=(devcortex)
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  DC=(node "$ROOT/apps/cli/dist/cli.js")
fi

pause() { sleep "${DEMO_PAUSE:-1.4}"; }
say()   { printf '\n\033[1;32m▶ %s\033[0m\n' "$1"; }

REPO="$(mktemp -d)/acme-checkout"
mkdir -p "$REPO/test"

# The AI agent "fixed the tax bug" in the checkout total and said it was done.
cat > "$REPO/package.json" <<'JSON'
{ "name": "acme-checkout", "version": "1.0.0", "type": "module",
  "scripts": { "test": "node --test" } }
JSON
cat > "$REPO/checkout.js" <<'JS'
export function total(items) {
  return items.reduce((s, i) => s + i.price, 0); // agent forgot the tax
}
JS
cat > "$REPO/test/checkout.test.js" <<'JS'
import { test } from 'node:test';
import assert from 'node:assert';
import { total } from '../checkout.js';
test('total includes 10% tax', () => assert.equal(total([{ price: 100 }]), 110));
JS

say "devcortex init  — build the project brain"
"${DC[@]}" init --cwd "$REPO" | tail -1
# a tiny lib legitimately has only a test gate:
node -e "const f='$REPO/.cortex/config.yaml',fs=require('fs');let y=fs.readFileSync(f,'utf8');y=y.replace(/typecheck: true/,'typecheck: false').replace(/lint: true/,'lint: false').replace(/build: true/,'build: false');fs.writeFileSync(f,y)"
pause

say "The agent says it's done.  devcortex ship —"
"${DC[@]}" ship --cwd "$REPO" || true   # exits 2 on NOT_READY
pause

say "Fix the root cause (add the 10% tax) and ship again —"
cat > "$REPO/checkout.js" <<'JS'
export function total(items) {
  const subtotal = items.reduce((s, i) => s + i.price, 0);
  return subtotal + subtotal / 10; // 10% tax
}
JS
"${DC[@]}" ship --cwd "$REPO"

echo
say "Done means proven — not just claimed."
