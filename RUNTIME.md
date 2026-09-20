# ai-runtime — deljeni AI runtime

Ovaj direktorijum je **deljena infrastruktura** koju koriste domeni (i po potrebi app):
- `cell-shell/` — Electron ljuska (GUI domena)
- `router-api/` — ai-router (`:4800`)
- `vector-dbs/` — qdrant (`:6333`) + `global_graph_vault` (deljeni atomi)
- `second-brain/` — vizuelni GUI (`:4901`)

## Kako ga domeni/app koriste (portabilno — bez hardkodovanih putanja)
1. **Marker:** `runtime.json` identifikuje koren runtime-a.
2. **Resolver:** `resolve-ai-runtime.sh` (i inline verzija u svakom `start.sh`) vraća koren:
   redosled `$AI_RUNTIME` → `~/ai/core-infrastructure` → `~/.local/share/ai-runtime` → `/opt/ai-runtime`
   (prvi sa `runtime.json`). Tako domen radi bez obzira gde je premešten.
3. **Kontrola:** `runtime.sh status|check|install` — proveri/obezbedi komponente + OS-alate.

## Premeštanje / druga mašina
- Postavi `AI_RUNTIME=/putanja/do/runtime` ili instaliraj runtime na poznatu lokaciju.
- `runtime.sh install` gradi/obezbeđuje komponente (npm ci cell-shell, tsc router, qdrant binar, enable servisi).

## Napomena
`node_modules` (root) je build-only (typescript; ruter u runtime-u = Node stdlib). `dist/` je build.
Podaci qdrant/global_graph_vault su van gita (v. `.gitignore`).
