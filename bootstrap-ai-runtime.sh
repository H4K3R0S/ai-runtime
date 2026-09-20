#!/bin/sh
# bootstrap-ai-runtime — vrati koren deljenog AI runtime-a; ako fali → kloniraj+instaliraj.
# Portabilno: bundle-uje se uz svaki domen/app. Config (env):
#   AI_RUNTIME            fiksna lokacija runtime-a (ako je već tu)
#   AI_RUNTIME_HOME       gde instalirati ako fali (default ~/.local/share/ai-runtime)
#   AI_RUNTIME_REPO       git URL runtime paketa
#   AI_RUNTIME_NOINSTALL=1  samo resolve (ne kloniraj/instaliraj)
set -u
_marker() { [ -f "$1/runtime.json" ]; }
_resolve() {
  for c in "${AI_RUNTIME:-}" "$HOME/ai/core-infrastructure" "$HOME/.local/share/ai-runtime" "/opt/ai-runtime"; do
    [ -n "$c" ] && _marker "$c" && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
rt="$(_resolve 2>/dev/null)" && { printf '%s\n' "$rt"; exit 0; }
[ "${AI_RUNTIME_NOINSTALL:-0}" = "1" ] && { echo "ai-runtime nije nađen." >&2; exit 1; }
home="${AI_RUNTIME_HOME:-$HOME/.local/share/ai-runtime}"
repo="${AI_RUNTIME_REPO:-https://github.com/H4K3R0S/ai-runtime.git}"
echo "[bootstrap] ai-runtime nije nađen → kloniram $repo → $home" >&2
command -v git >/dev/null 2>&1 || { echo "git nije instaliran (OS zavisnost)." >&2; exit 1; }
[ -d "$home/.git" ] || git clone --depth 1 "$repo" "$home" >&2 || { echo "klon runtime-a nije uspeo." >&2; exit 1; }
if _marker "$home"; then
  [ -x "$home/runtime.sh" ] && "$home/runtime.sh" install >&2 || true
  printf '%s\n' "$home"; exit 0
fi
echo "runtime kloniran ali nema runtime.json." >&2; exit 1
