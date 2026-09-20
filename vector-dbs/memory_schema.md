---
id: memory-schema
title: Šema globalne vektorske baze (Qdrant, 3 kolekcije)
type: reference
tags: [vektor, memorija, qdrant, cross-domain]
created: 2026-09-18
domain: os
---

# Globalna vektorska baza — šema (F4)

Prati arhitekturu iz `UNAPREDJENJE/01-ARHITEKTURA/04-globalna-vektorska-baza.md`.
Ovaj fajl dokumentuje STVARNO stanje: 3 Qdrant kolekcije, payload polja,
embed model/dimenziju i kako se puni/čita preko `memory_client.py`.

## Servisi (INFRA, već postavljena)

| Servis | Endpoint | Napomena |
|---|---|---|
| Qdrant 1.19.1 | `http://127.0.0.1:6333` | systemd `--user` servis, REST API |
| Ollama embed | `POST http://127.0.0.1:11434/api/embed` | model `nomic-embed-text`, 768d |

Embed poziv: `{"model": "nomic-embed-text", "input": "<tekst>"}` →
`{"embeddings": [[...768 float...]]}`.

## Klijent

Kanonski original: `~/ai/core-infrastructure/tools/memory_client.py`
(stdlib `urllib`, bez pip zavisnosti). Lokalne kopije (identičan fajl) žive u
`core/cell/memory_client.py` u sva 4 domena, da bi `fallthrough.py` mogao
lokalni import bez zavisnosti između ćelija:

- `~/ai/domains/kalima/core/cell/memory_client.py`
- `~/ai/domains/codium/core/cell/memory_client.py`
- `~/ai/domains/imperium/core/cell/memory_client.py`
- `~/ai/domains/filmium/core/cell/memory_client.py` — **čeka F: sync** (vidi
  `filmium-domains-setup.md`); lokalna Linux kopija je ažurna, ali se NE
  gura ručno na F: iz ovog prolaza (flagovano, ne dirano po pravilu zadatka).

Menjati SAMO kanonski original pa ručno prekopirati u domene (isti fajl, bez
izmena po domenu — sinhronizacija je ručna, po istom principu kao `atom_lint.py`
koji čuva `slugify()` identičnim originalu).

### API (`memory_client.py`)

| Funkcija | Signature | Ponašanje pri grešci |
|---|---|---|
| `embed` | `embed(text: str) -> list[float]` | `[]` (Ollama dole/prazan tekst) |
| `ensure_collection` | `ensure_collection(name, dim=768, distance="Cosine") -> bool` | `False`, ne diže izuzetak; idempotentno — ne dira postojeću kolekciju |
| `memory_init` | `memory_init() -> dict[str, bool]` | inicijalizuje sve 3 kolekcije odjednom |
| `upsert` | `upsert(collection, point_id, text, payload=None) -> bool` | `False` (Ollama/Qdrant dole) |
| `search` | `search(collection, text, k=5, flt=None) -> list[dict]` | `[]` |

`point_id` može biti bilo koji string (npr. atom slug) — interno se
determinstički mapira u **UUIDv5** (fiksni namespace
`a2b19c1e-6f2b-5f1a-8e6f-2f9b1c7d4e10`), pa isti slug UVEK daje isti
Qdrant point-id → upsert je idempotentan po `id`, kako zahteva arhitektura.
Ako je `point_id` već ceo broj ili validan UUID, koristi se direktno.

`search()` rezultat je lista `{"id": ..., "score": ..., "payload": {...}}`.

CLI: `python3 memory_client.py init` — kreira (ili potvrđuje) sve 3
kolekcije i ispisuje `OK`/`FAIL` po kolekciji.

## 3 kolekcije

Sve su 768-dimenzione, `distance=Cosine` (isti embed model za sve — nema
mešanja dimenzija).

### 1. `cross_domain_knowledge` — dokazana rešenja / CISA lekcije

Puni se iz CISA petlje (`06-cisa-samoucenje.md`): kad `LearnedAtomStore`
upiše naučeni atom u `.ai/atomi/nauceno/<slug>.md`, best-effort upsert ovde.

```json
{
  "id": "<UUIDv5 od slug-a>",
  "vector": [/* 768d */],
  "payload": {
    "origin_domain": "kalima",
    "origin_agent": "izvidjac",
    "markdown": "[[learn-sqlmap-cloudflare-bypass]]",
    "topic": "waf-bypass",
    "solution_status": "proven",
    "confidence": 0.9,
    "updated": "2026-09-18T13:05:00Z",
    "document": "Problem: ... Rešenje: --tamper=space2comment ..."
  }
}
```

`document` = telo naučenog atoma (tekst koji se embeduje); dodaje ga
`upsert()` automatski u payload ako nije eksplicitno prosleđen.

### 2. `context_entity_index` — semantički indeks `[[entiteta]]`

Mapira mete, filmove, kod, niše u zajednički vektorski prostor; nalazi veze
i kad se nazivi razlikuju po domenu. Payload minimum:

```json
{
  "payload": {
    "entity_name": "...",
    "entity_type": "target|film|code|niche|...",
    "origin_domain": "...",
    "cross_domain_references": ["[[...]]", "..."],
    "updated": "..."
  }
}
```

Nije ožičena automatska petlja punjenja u ovom prolazu (van obima zadatka
F4-koraka koji je urađen ovde) — kolekcija je kreirana i spremna za
buduću integraciju (entity-extraction sloj).

### 3. `episodic_log` — vremenska traka događaja

Skenovi, importi, objave i sl. — kratkotrajno pamćenje (preporučena
retencija ~90 dana, čišćenje NIJE implementirano u ovom prolazu — TODO za
kasnije: periodičan `points/delete` sa `filter` po `updated` starijem od
90 dana). Payload minimum:

```json
{
  "payload": {
    "event_type": "scan|import|publish|...",
    "origin_domain": "...",
    "summary": "...",
    "updated": "..."
  }
}
```

Takođe kreirana i spremna, punjenje van obima ovog prolaza.

## Kako se puni (write)

CISA petlja, kuka u `LearnedAtomStore.write()` (`core/cell/fallthrough.py`,
sva 4 domena): posle uspešnog upisa `.md` atoma, best-effort:

```python
memory_client.upsert(
    "cross_domain_knowledge",
    slug,
    body_teksta_atoma,
    {"origin_domain": domain, "markdown": f"[[{slug}]]", "updated": iso_now},
)
```

Try/except oko poziva — ako Qdrant/Ollama padnu, `.md` atom je već upisan
(FS write je prvi, vektor-upsert je best-effort DODATAK, nikad blokira).

## Kako se čita (read)

`HybridRetriever` vektor-sloj i ruter graf-keš mogu da pitaju
`cross_domain_knowledge` za cross-domain bonus preko `memory_client.search()`.
**Napomena:** samo `HybridRetriever` je i dalje ožičen na pgvector (mrtav) —
prebacivanje njegovog vektor-sloja da gađa Qdrant preko ovog klijenta je
**opcioni sledeći korak, NIJE urađen u ovom prolazu** (van obima — ruter i
search moduli namerno nisu dirani sada).

## Degradacija

Ako je Qdrant ili Ollama nedostupan: `embed()` → `[]`, `upsert()`/`search()`
→ `False`/`[]`, nikad izuzetak. `LearnedAtomStore.write()` i dalje upisuje
`.md` atom nezavisno (FS write se ne oslanja na vektor sloj). Sistem radi na
FTS5 + graf-vault kao i pre F4 (vektor je bonus sloj, ne blokira ništa).
