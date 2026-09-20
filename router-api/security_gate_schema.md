---
id: security-gate-schema
title: Security Gate Schema — izvor istine matrice rizika + gate JSON
type: spec
tags: [bezbednost, approval, gate, rizik, allowlist, executor]
created: 2026-09-18
domain: os
---

# Security Gate Schema (izvor istine)

Ovaj fajl je "izvor istine" koji `01-ARHITEKTURA/05-approval-gates.md` i
`01-ARHITEKTURA/10-mcp-tool-executor.md` referenciraju iz `[FaN]`. Implementacija
(F5): `core/cell/executor.py` + `core/cell/approvals.py`, identicni u sva 4
domena (`~/ai/domains/{codium,filmium,imperium,kalima}/core/cell/`).

[CAVEAT] `~/ai/core-infrastructure` NIJE git repozitorijum (provereno
`git status` -> "fatal: not a git repository"). Ovaj fajl je NOV (nije
postojao pre ove izmene), pa nije pravljen `.bak` — pravilo za buduce izmene
OVOG fajla: napraviti `security_gate_schema.md.bak` PRE prepisivanja, jer nema
git istorije koja bi cuvala prethodnu verziju.

## Matrica rizika

| Nivo | Primeri | Ponašanje | Scope-provera (meta) |
|------|---------|-----------|-----------------------|
| LOW | čitanje fajlova, `sha256sum`, pasivni `ggraph get`, FTS upit, `rg` offline | autonomno + audit | SAMO ako alat cilja metu (npr. `subfinder`) |
| MEDIUM | pisanje koda na disk (Codium), FILMIUM import, `mpv` play, SearXNG upit, `httpx` | autonomno + audit + emit | SAMO ako alat cilja metu (npr. `httpx`) |
| HIGH | `git push` na javni remote, brisanje atoma, masovni reindex, TTS/objava, `hashcat` (offline crack, v. napomena) | **GATE** | po potrebi (v. per-alat) |
| CRITICAL | `nmap`/`nuclei`/`sqlmap`/`ffuf`/`gobuster`/`nikto`/`dalfox`/`hydra` na META | **GATE + potvrda scope-a** | OBAVEZNA (target_asset) |

Izvor: `01-ARHITEKTURA/05-approval-gates.md`, domenski uskladjeno u
`05-KALIMA/alati/katalog.md`.

### Napomena o `hashcat`

`05-KALIMA/alati/katalog.md` klasifikuje `hashcat` kao **HIGH** (offline,
bez mreže, SAMO nad kredencijalima iz autorizovanog `evidence` atoma preko
`authorization_ref` — nema živu mrežnu metu, pa `target_asset` scope-provera
ne važi na isti način kao za `nmap`). `config/tools.allow.json` (KALIMA) ga
ipak drži kao **CRITICAL** — stroža klasifikacija, svesno odabrana da bude
usaglašena sa listom iz F5 zadatka i sa FAIL-CLOSED načelom (nedoumica u
klasifikaciji → stroži nivo, nikad slabiji). Razlog nije greška — ovo je
zabeleženo odstupanje, ne haluciniran podatak.

## Klasifikacija PO ALATU, ne po podkomandi [poznato ograničenje]

F5 executor klasifikuje rizik **po binaru**, ne po pod-komandi. Primer:
`git status` (LOW) i `git push` (HIGH) dobijaju ISTU klasifikaciju danas jer
`config/tools.allow.json` ima jedan unos `git`. Ovo je dokumentovano
ograničenje (v. `config/tools.allow.json` u CODIUM, polje `note` na unosu
`git`) — podkomandna klasifikacija je per-domen follow-up PRE nego što se
`git`/`rsync`/itd. stvarno oziče kroz `Executor`.

## JSON zahteva za dozvolu (executor → GUI)

```json
{ "gate_id": "gate_<rand>_critical",
  "timestamp": "2026-09-18T13:10:22Z",
  "security_status": "AWAITING_USER_APPROVAL",
  "interrupted_agent": {"domain": "kalima", "sub_agent": "izvidjac"},
  "risk_assessment": {"level": "CRITICAL",
     "reason": "Aktivno skeniranje žive mete; potreban autorizovan scope."},
  "proposed_action": {"execution_type": "bash_command",
     "binary": "/usr/bin/nmap",
     "raw_command": "nmap -sV -p 8080 <TARGET>",
     "scope_ref": "[[kalima-target-<...>]]"},
  "security_token": "sha256:<hex>",
  "expires_in_s": 120 }
```

Implementacija u `core/cell/approvals.py`: `Approvals.create_gate(...)` vraća
`(Gate, token)`. `Gate` nosi ista polja (`id`, `tool`, `args`, `risk`,
`reason`, `actor`, `scope_ref`, `status`, `requested_at`, `expires_at`).
`token` je heksa SHA256 otisak slučajne tajne; u bazi se čuva SAMO
`sha256(token)` (dupli otisak) — kompromitovana baza sama po sebi ne daje
upotrebljiv token.

## Tok (implementiran u `core/cell/executor.py`)

1. `Executor.classify(tool)` — allowlist provera (`config/tools.allow.json`).
   Nepoznat alat → `risk is None`, NE izvršava se. Nejasan/nepoznat `risk` u
   konfiguraciji → tretira se kao CRITICAL (fail-closed), nikad tiho kao
   nešto slabije.
2. `Executor._check_scope(...)` — za alate sa `targets_network: true`:
   proverava `target_asset.authorized` + `authorization_ref` + `scope`, i da
   meta nije na `out_of_scope` listi. Bez toga → `REJECTED` (auto-reject),
   BEZ gate-a, BEZ ijednog paketa na mreži. Ova provera je NEZAVISNA od
   risk-nivoa — važi i za LOW/MEDIUM alate koji ciljaju metu (npr.
   `subfinder`, `httpx`), ne samo za CRITICAL.
3. LOW/MEDIUM (posle scope-provere, ako je primenjiva) → izvršava se odmah
   (`subprocess.run(..., shell=False, timeout=...)`), izlaz ograničen na
   poslednjih 4000 znakova.
4. HIGH/CRITICAL → NE izvršava se; `Approvals.create_gate(...)` upisuje
   molbu u `data/approvals.db` (SQLite, tabela `approvals`) i vraća
   `AWAITING_APPROVAL` sa `gate_id` + `token`.
5. GUI (Second Brain / domen) prikazuje Approval Card. `[ODOBRI]` →
   `Approvals.approve(gate_id, token)` (FAIL-CLOSED: pogrešan token ili
   istekla molba → `None`, ništa se ne izvršava). `[ODBIJ]` →
   `Approvals.reject(gate_id)`.
6. Odobrena molba (`Gate` sa `status == "approved"`) ide u
   `Executor.execute_approved(gate)`, koji je izvršava PRVI I JEDINI put
   (isto bezbednosno svojstvo kao CODIUM `AgentLoop.resume()`: jedna
   atomska `UPDATE ... WHERE status='pending'` sprečava dvostruku odluku, pa
   i dvostruko izvršenje).
7. Posle SVAKOG izvršenja (LOW/MEDIUM autonomno ILI odobreno HIGH/CRITICAL):
   audit atom `type: log` u `.ai/atomi/logs/executor/<slug>.md`
   (`01-atomski-standard-v2.md` format, `id == slugify(title)`) + best-effort
   SSE `POST http://127.0.0.1:4901/api/events` (Second Brain hub,
   `~/ai/core-infrastructure/second-brain/server.mjs`). Emit NIKAD ne obara
   izvršenje — obavijeno u `try/except Exception`, kratak timeout (0.3s).

## Autorizacija scope-a (KALIMA specifično)

CRITICAL (i svaki `targets_network: true` alat) nad metom zahteva da meta
ima atom `type:target_asset` sa poljem `authorized: true` i
`scope`/`authorization_ref` (v. `05-KALIMA/faze/F0-engagement-i-scope.md`).
Bez toga → gate se odbija automatski uz poruku „meta nije u autorizovanom
scope-u". `Executor` ovo NE čita direktno sa diska — prima ubrizganu
`asset_lookup: Callable[[str], TargetAsset | None]` funkciju (isti obrazac
kao CODIUM `ScopeGate(rules=...)`), da bi mašinerija ostala testabilna bez
ijednog stvarnog atoma. Production wiring (parsiranje pravih
`.ai/atomi/kalima/*.md` `target_asset` atoma u `asset_lookup`) NIJE urađeno
u F5 — to je sledeći korak, zajedno sa stvarnim ožičavanjem `nmap`/`nuclei`/
`sqlmap`/itd. iza ovog Executor-a (v. F5 izveštaj/DoD).

## Allowlist po domenu

Živi izvor: `<domen>/config/tools.allow.json`. Sažetak (F5, 2026-09-18):

- **CODIUM:** `rg` (LOW), `git`/`python3`/`node`/`sqlite3`/`pytest` (MEDIUM).
- **FILMIUM:** `ffprobe`/`ffmpeg`/`mediainfo`/`mpv`/`rsync` (svi MEDIUM).
- **IMPERIUM:** `curl` (LOW), `ollama` (MEDIUM). TTS/SD planirano, još nema
  konkretnog binara u allowlisti.
- **KALIMA:** `sha256sum`/`rg` (LOW); `httpx` (MEDIUM, scope); `subfinder`
  (LOW, scope, planned — nije instaliran); `nmap`/`nuclei`/`sqlmap`/`ffuf`/
  `gobuster`/`nikto`/`dalfox`/`hydra`/`hashcat` (CRITICAL — `dalfox` planned).

## [DoD]

- `nmap` nad metom bez `authorized:true` se ODBIJA automatski (test —
  `tests/test_approval_gate_executor.py`, KALIMA).
- CRITICAL komanda čeka odobrenje; bez odobrenja nema izvršenja (test).
- Pogrešan token se odbija; istekla molba se odbija makar token bio tačan
  (test).
- Svaka izvršena akcija ostavlja audit atom (`type: log`); odobrena
  HIGH/CRITICAL akcija nosi `gate_id` u detalju atoma (test).
- Non-allowlist/nepoznat alat → greška, ne izvršenje (test).
- `import core.cell.executor` i `import core.cell.approvals` prolaze u sva 4
  domena (regresija).

## [FaN]

- `core/cell/executor.py`, `core/cell/approvals.py` — identični u sva 4
  domena.
- `config/tools.allow.json` — po domenu, sadržaj se razlikuje.
- Per-domen follow-up: stvarno ožičavanje domenskih alata (KALIMA
  `nmap`/`nuclei`/`sqlmap`/..., CODIUM `git`/`pytest`/..., FILMIUM
  `ffmpeg`/..., IMPERIUM `curl`/`ollama`) da pozivaju `Executor.run(...)`
  umesto direktnog `subprocess`; realan `asset_lookup` koji čita
  `.ai/atomi/kalima/*.md` `target_asset` atome; GUI Approval Card (Second
  Brain) koji sluša `type:"gate"` SSE događaje i zove
  `Approvals.approve/reject`; git podkomandna klasifikacija (`push` → HIGH).
- FILMIUM [FLAG]: ova faza je menjala SAMO Linux kopiju
  (`~/ai/domains/filmium`). F:\ Windows sync kopija NIJE dirana iz ove
  sesije (nema pristupa) — `core/cell/executor.py`, `core/cell/approvals.py`
  i `config/tools.allow.json` treba ručno sinhronizovati na F:\ pri sledećem
  FILMIUM build/sync koraku.
