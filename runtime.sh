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
  _install_qdrant
  # enable servisi ako postoje unit fajlovi
  for s in ai-router qdrant; do
    [ -f "$HOME/.config/systemd/user/$s.service" ] && systemctl --user enable --now "$s.service" 2>/dev/null
  done
  check
}

_install_qdrant() {
  dst="$RT/vector-dbs/qdrant/qdrant"
  [ -x "$dst" ] && { echo "-> qdrant već prisutan."; return 0; }
  ver="${QDRANT_VERSION:-1.19.1}"
  case "$(uname -m)" in
    x86_64)        target="x86_64-unknown-linux-gnu";;
    aarch64|arm64) target="aarch64-unknown-linux-musl";;
    *) echo "-> qdrant: nepoznata arhitektura $(uname -m) — preuzmi ručno."; return 1;;
  esac
  url="https://github.com/qdrant/qdrant/releases/download/v${ver}/qdrant-${target}.tar.gz"
  echo "-> qdrant $ver ($target): $url"
  command -v curl >/dev/null 2>&1 || { echo "   curl nedostaje (OS)."; return 1; }
  tmp="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmp/q.tar.gz"; then
    tar -xzf "$tmp/q.tar.gz" -C "$tmp" 2>/dev/null
    bin="$(find "$tmp" -name qdrant -type f 2>/dev/null | head -1)"
    if [ -n "$bin" ]; then
      mkdir -p "$RT/vector-dbs/qdrant"; cp "$bin" "$dst"; chmod +x "$dst"; echo "   ✓ qdrant instaliran."
    else echo "   qdrant binar nije nađen u arhivi."; fi
  else echo "   preuzimanje nije uspelo ($url)."; fi
  rm -rf "$tmp"
}

case "$cmd" in
  path)    echo "$RT";;
  status)  status;;
  check)   check;;
  install) install;;
  *) echo "upotreba: runtime.sh [status|check|install|path]"; exit 2;;
esac
