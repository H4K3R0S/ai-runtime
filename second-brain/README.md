# AI OS — Second Brain (centralni GUI)

Centralni vizuelni sloj AI OS-a na nivou operativnog sistema (nije u domenu).
Prikazuje kontekst kroz **4 koncentrične orbite (ARMS okvir)**:

- **Applications** (plava, spoljna) — domeni preko MCP/API (iz router manifesta).
- **Routines** (žuta) — automatizovane pozadinske rutine (OS servisi: `ai-router`,
  `searxng`, `ollama` + agent-loop po domenu).
- **Memory** (ljubičasta) — atomske markdown beleške + logovi po domenu (RAG baze).
- **Skills** (narandžasta, jezgro) — kapabilnosti agenata (iz manifesta).

Stack: Vite + React 19 + TypeScript (isti kao domenski GUI-jevi). Podaci se
povlače iz `~/ai/core-infrastructure/router-api/system_routing_manifest.json`
(servira se preko `public/system_routing_manifest.json` symlinka) i lokalnih RAG
baza. Render je HTML5 Canvas sa `requestAnimationFrame` rotacijom (solarni sistem);
svaki čvor računa (X, Y) preko cos/sin u odnosu na vreme.

## Pokretanje
    cd ~/ai/core-infrastructure/second-brain
    npm install          # prvi put (uz @rolldown/binding-linux-x64-gnu za Vite 8)
    npm run serve        # Node backend (server.mjs): dist/ + /api na 4901  <-- preporuceno
    #   ILI za razvoj (dva procesa):
    npm run serve &      # backend /api na 4901
    npm run dev          # Vite dev na 4900 (proxy /api -> 4901)
    npm run build        # produkcioni build u dist/

Backend `server.mjs` (bez npm zavisnosti) bezbedno cita atome sa diska:
`GET /api/atoms` (lista za Memory orbitu) i `GET /api/atom?path=<id>` (sadrzaj
jednog atoma). Koreni: globalni vault + `~/ai/domains/<d>/.ai/atomi`. Ovo je
Electron/HTTP zamena za Tauri `invoke`/Rust iz specifikacije.

## Status po koracima (2 Second brain upgrade)
- [x] 1 — OrbitalSecondBrain.tsx: stabilan Canvas render + rotacija (ovaj korak).
- [x] 2 — raycasting hover/klik + svetleće relacione linije (uživo prate rotaciju).
- [x] 3 — FileInspectorSidebar.tsx (klizni panel; klik Memory atoma -> backend čita fajl).
- [x] 4 — reaktivna tabla uživo: SSE događaji -> spawn čvorova (interpolacija + linija) + live sidebar.
- [x] 5 — InfiniteCanvasWorkspace.tsx (React Flow): beskonačno platno, rich kartice + mini-čet (Ollama), bezier veze.
- [x] 6 — MediaPreviewCard (slike/PDF/video) + MediaViewerSidebar (maksimizacija u punoj rez.).
- [x] 7 — izbor mete (fokus/centriranje grafa) + live loot spawning (SSE) + Collapse/Expand All.

Napomena: dokumenti pominju "Tauri" - stvarni pokretač je Electron (kao
cell-shell); Tauri IPC / invoke / listen se u koracima 3/4/6 preslikavaju na
Electron IPC ili HTTP/SSE ka router-api.

## Događaji uživo (KORAK 4)
Pozadina (router-api / domeni / alati poput Nuclei, ZAP) šalje događaje na
event-hub; svi GUI klijenti ih dobiju preko SSE (`/api/events`).

Oblik događaja:
```json
{ "domain": "kalima", "type": "memory", "label": "cve_found.md",
  "parent": "KALIMA", "path": "kalima/nauceno/cve.md", "append": "novi log…" }
```
- `type`: `memory` | `routine` | `app` | `skill` (bira orbitu).
- `parent`: id ili labela čvora-mete (linija rađanja); podrazumevano `app:<domain>`.
- `path` + `append` (opciono): ako je baš taj atom otvoren u sidebar-u, tekst se
  uživo dopisuje (streaming), bez ponovnog klika.

Primer (rađanje čvora):
```bash
curl -s -X POST http://127.0.0.1:4901/api/events -H 'content-type: application/json' \
  -d '{"domain":"kalima","type":"memory","label":"cve_found.md","parent":"KALIMA"}'
```

## Infinite Canvas (KORAK 5)
`InfiniteCanvasWorkspace.tsx` koristi **React Flow (`@xyflow/react`)** (naš primarni
framework je React; spec dozvoljava React Flow umesto tldraw). Prekidač "Kanvas"
u zaglavlju. Rich kartica po atomu: ikona tipa, naslov, snippet, i mini ČET polje
("Ask a question…") koje pita ISKLJUČIVO taj fajl preko `POST /api/ask` (lokalni
Ollama, izolovan kontekst). Veze: bezier krive iz `[[linkova]]` + diskretan
po-domen strukturni backbone. Pan/zoom točkićem, minimap + kontrole.

## Media preview (KORAK 6)
Multimedijalne zavisnosti (`.png/.jpg/.gif/.webp/.pdf/.mp4/.webm`) se prikazuju kao
`MediaPreviewCard` u lane-u desno, povezane tankom SVG linijom sa hub atomom domena
(veza prati pan/zoom). Slike se učitavaju lenjo (`loading="lazy"`). Klik na karticu
otvara `MediaViewerSidebar` (klizni panel) sa fajlom u punoj rezoluciji. Backend:
`GET /api/media-list` i `GET /api/media?path=<token>` (streaming + Range, provera
korena — Electron/HTTP zamena za Tauri convertFileSrc). Media koreni:
`<domen>/.ai/razvoj/reference-slike` i `<domen>/data/screenshots`.

## Dashboard/live integracija (KORAK 7)
Toolbar u kanvasu: **Meta** (izbor mete/domena) — filtrira i centrira graf te mete
(`fitView` na njene čvorove); **Collapse All / Expand All** — sakrij/prikaži sve
media preview kartice (`hidden`, pozicije se čuvaju). **Live loot spawning:** SSE
događaj (`/api/events`) rađa novu karticu (tekst = atom, slika = media) na dnu
kolone domena i spaja je linijom sa hub čvorom — bez refresh-a. FIFO cap
(MAX_LIVE=24) + `unlisten` na unmount (bez memory leak-a).

Sav Second Brain upgrade (koraci 1–7) je završen: orbitalni prikaz (1–4) i
Infinite Canvas (5–7).
