#!/bin/bash
# ai-runtime kontrola — status/check/install deljene infrastrukture. Self-locating.
# Koriste ga domeni/app (preko resolve-ai-runtime.sh) da obezbede runtime pre pokretanja.
set -u
cd "$(dirname "$(readlink -f "$0")")" || exit 1
RT="$PWD"
cmd="${1:-status}"

_svc() { systemctl --user is-active "$1" 2>/dev/null || echo "inactive"; }
_port() { curl -s -m2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$1/" 2>/dev/null || echo "down"; }

status() {
  echo "ai-runtime: $RT"
  echo "  ai-router.service : $(_svc ai-router.service)   (:4800 -> $(_port 4800))"
  echo "  qdrant.service    : $(_svc qdrant.service)   (:6333 -> $(_port 6333))"
  echo "  second-brain      : (:4901 -> $(_port 4901))"
  echo "  cell-shell        : $([ -x "$RT/cell-shell/node_modules/.bin/electron" ] && echo OK || echo 'nema electron')"
}

# vrati listu nedostajućih (prazno = sve ok)
_missing() {
  local m=()
  command -v node >/dev/null 2>&1 || m+=("node(OS)")
  command -v python3 >/dev/null 2>&1 || m+=("python3(OS)")
  [ -x "$RT/cell-shell/node_modules/.bin/electron" ] || m+=("cell-shell/node_modules")
  [ -f "$RT/router-api/dist/router-api/router.js" ] || m+=("router-api/dist(build)")
  [ -x "$RT/vector-dbs/qdrant/qdrant" ] || m+=("qdrant-binary")
  printf '%s\n' "${m[@]}"
}

check() {
  local miss; miss="$(_missing)"
  if [ -z "$miss" ]; then echo "✓ runtime kompletan."; return 0; fi
  echo "Nedostaje:"; echo "$miss" | sed 's/^/  - /'; return 1
}

install() {
  echo "== install/provision runtime =="
  if command -v npm >/dev/null 2>&1 && [ ! -x "$RT/cell-shell/node_modules/.bin/electron" ] && [ -f "$RT/cell-shell/package.json" ]; then
    echo "-> cell-shell: npm ci"; (cd "$RT/cell-shell" && npm ci --no-audit --no-fund) || echo "  (npm ci pao)"
  fi
  if [ ! -f "$RT/router-api/dist/router-api/router.js" ] && [ -f "$RT/router-api/tsconfig.json" ]; then
    echo "-> router-api: build (tsc)"; (cd "$RT" && command -v npm >/dev/null && npm ci --no-audit --no-fund >/dev/null 2>&1; cd "$RT/router-api" && npx tsc -p tsconfig.json) || echo "  (tsc pao)"
  fi
  [ -x "$RT/vector-dbs/qdrant/qdrant" ] || echo "-> qdrant binar nedostaje: preuzmi u vector-dbs/qdrant/ (v. README)."
  # enable servisi ako postoje unit fajlovi
  for s in ai-router qdrant; do
    [ -f "$HOME/.config/systemd/user/$s.service" ] && systemctl --user enable --now "$s.service" 2>/dev/null
  done
  check
}

case "$cmd" in
  path)    echo "$RT";;
  status)  status;;
  check)   check;;
  install) install;;
  *) echo "upotreba: runtime.sh [status|check|install|path]"; exit 2;;
esac
