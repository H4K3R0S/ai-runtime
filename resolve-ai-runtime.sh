#!/bin/sh
# resolve-ai-runtime — ispiši koren deljenog AI runtime-a (marker: runtime.json).
# Redosled: $AI_RUNTIME → poznati kandidati. Prazno + exit 1 ako nije nađen.
# Portabilno: kopira se uz svaki domen/app da razreši runtime bez hardkodovanja.
for c in "$AI_RUNTIME" "$HOME/ai/core-infrastructure" "$HOME/.local/share/ai-runtime" "/opt/ai-runtime"; do
  if [ -n "$c" ] && [ -f "$c/runtime.json" ]; then
    printf '%s\n' "$c"
    exit 0
  fi
done
echo "ai-runtime nije nađen (postavi \$AI_RUNTIME ili instaliraj runtime)." >&2
exit 1
