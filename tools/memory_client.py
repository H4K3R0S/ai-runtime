#!/usr/bin/env python3
"""memory_client.py — kanonski klijent ka globalnoj vektorskoj bazi (Qdrant)
i lokalnom embedding modelu (Ollama `nomic-embed-text`, 768 dimenzija).

Deo F4 faze (globalna vektorska baza + dugoročno pamćenje, vidi
`UNAPREDJENJE/01-ARHITEKTURA/04-globalna-vektorska-baza.md`). Svaki domen
(KALIMA, CODIUM, IMPERIUM, FILMIUM) drži LOKALNU kopiju ovog fajla
(`core/cell/memory_client.py`) da bi `fallthrough.py` mogao lokalni import
bez paket-zavisnosti između ćelija. Kanonski original živi ovde; menjati
OVDE pa kopirati u sve domene (vidi napomenu na dnu fajla).

Servisi (već postavljeni, INFRA proverena):
  - Qdrant 1.19.1, systemd `--user`, REST na 127.0.0.1:6333
  - Ollama, model `nomic-embed-text` (768d), POST /api/embed na 127.0.0.1:11434

Samo Python stdlib (`urllib`) — BEZ novih pip zavisnosti. Isti duh kao
`fallthrough.py`: SVE je best-effort/tolerantno — ako je Qdrant ili Ollama
dole, funkcije vraćaju prazno/False/no-op i NIKAD ne bacaju izuzetak napolje.
Poruke (log) na srpskom (latinica).
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
import uuid
from typing import Any

_logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Konfiguracija (fiksni lokalni endpointi — nema env/config sloja, u duhu
# ostatka ćelijskog koda koji radi na 127.0.0.1).
# --------------------------------------------------------------------------
OLLAMA_EMBED_URL = "http://127.0.0.1:11434/api/embed"
QDRANT_URL = "http://127.0.0.1:6333"
EMBED_MODEL = "nomic-embed-text"
EMBED_DIM = 768

_EMBED_TIMEOUT = 5.0   # Ollama embed poziv — malo sporiji (CPU/GPU zavisno)
_QDRANT_TIMEOUT = 4.0  # Qdrant REST — brz, lokalni

# 3 globalne kolekcije (vidi 04-globalna-vektorska-baza.md).
COLLECTIONS: tuple[str, ...] = (
    "cross_domain_knowledge",
    "context_entity_index",
    "episodic_log",
)

# Fiksni namespace za UUIDv5 — isti string slug MORA uvek dati isti point-id
# (idempotentan upsert), i to identično u sva 4 domena (svi koriste ovaj isti
# namespace, jer je fajl kopiran, ne generisan). NE MENJATI ovu vrednost —
# promena bi „raskačila" postojeće point-id-jeve u Qdrant-u od svojih slugova.
_POINT_NAMESPACE = uuid.UUID("a2b19c1e-6f2b-5f1a-8e6f-2f9b1c7d4e10")


# --------------------------------------------------------------------------
# Nisko-nivo HTTP helper (stdlib urllib, JSON in/out).
# --------------------------------------------------------------------------
def _request(url: str, *, method: str = "GET", payload: dict | None = None,
             timeout: float = _QDRANT_TIMEOUT) -> Any:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"content-type": "application/json"} if data is not None else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw else None


# --------------------------------------------------------------------------
# Embedding (Ollama)
# --------------------------------------------------------------------------
def embed(text: str) -> list[float]:
    """Vrati 768d embedding za `text` preko Ollama `nomic-embed-text`.

    Tolerantno: prazan tekst, Ollama dole, model nedostupan, čudan odgovor →
    `[]` (nikad izuzetak)."""
    if not text or not text.strip():
        return []
    try:
        data = _request(
            OLLAMA_EMBED_URL, method="POST",
            payload={"model": EMBED_MODEL, "input": text},
            timeout=_EMBED_TIMEOUT,
        )
        vec = data["embeddings"][0]  # type: ignore[index]
        return [float(x) for x in vec]
    except Exception as error:  # noqa: BLE001 — embed je best-effort
        _logger.debug("memory_client.embed: ollama nedostupan/greška (%s)", error)
        return []


# --------------------------------------------------------------------------
# Kolekcije (Qdrant)
# --------------------------------------------------------------------------
def ensure_collection(name: str, dim: int = EMBED_DIM,
                       distance: str = "Cosine") -> bool:
    """Napravi kolekciju `name` ako ne postoji (idempotentno).

    Ne dira postojeću kolekciju (ne briše/rekreira) — samo proveri i, ako
    fali, napravi. `True` znači „kolekcija postoji (sad ili već pre)",
    `False` znači da Qdrant nije dostupan ili je zahtev odbijen."""
    try:
        _request(f"{QDRANT_URL}/collections/{name}", method="GET",
                  timeout=_QDRANT_TIMEOUT)
        return True  # 200 -> već postoji
    except urllib.error.HTTPError as error:
        if error.code != 404:
            _logger.debug("ensure_collection(%s): GET -> HTTP %s", name, error.code)
            return False
    except Exception as error:  # noqa: BLE001 — Qdrant dole = tolerantno
        _logger.debug("ensure_collection(%s): Qdrant nedostupan (%s)", name, error)
        return False

    try:
        _request(
            f"{QDRANT_URL}/collections/{name}", method="PUT",
            payload={"vectors": {"size": dim, "distance": distance}},
            timeout=_QDRANT_TIMEOUT,
        )
        return True
    except Exception as error:  # noqa: BLE001
        _logger.debug("ensure_collection(%s): kreiranje nije uspelo (%s)", name, error)
        return False


def memory_init() -> dict[str, bool]:
    """Inicijalizuj svih 5 (trenutno 3) globalnih kolekcija. Vrati mapu
    naziv -> uspeh (za log/test ispis)."""
    return {name: ensure_collection(name) for name in COLLECTIONS}


# --------------------------------------------------------------------------
# Point-id normalizacija
# --------------------------------------------------------------------------
def _to_point_id(point_id: Any) -> Any:
    """Qdrant point-id mora biti unsigned int ili UUID. Ako je `point_id` već
    int ili validan UUID string, koristi ga direktno; inače (npr. slug kao
    "learn-sqlmap-cloudflare-bypass") deterministički izvedi UUIDv5 iz
    stringa — isti slug uvek daje isti id (idempotentan upsert)."""
    if isinstance(point_id, int):
        return point_id
    s = str(point_id)
    if s.isdigit():
        return int(s)
    try:
        return str(uuid.UUID(s))
    except (ValueError, AttributeError):
        return str(uuid.uuid5(_POINT_NAMESPACE, s))


# --------------------------------------------------------------------------
# Upsert / Search
# --------------------------------------------------------------------------
def upsert(collection: str, point_id: Any, text: str,
           payload: dict | None = None) -> bool:
    """Embeduj `text` i upsertuj kao jednu tačku u `collection`.

    `point_id` je obično string slug (npr. id atoma) — automatski se mapira
    u UUIDv5 (vidi `_to_point_id`). `payload` se čuva uz vektor, plus
    `document` (originalni tekst) da `search` može da vrati sadržaj bez
    dodatnog čitanja fajla. Tolerantno: bilo koja greška (Ollama/Qdrant dole,
    kolekcija ne postoji...) → `False`, nikad izuzetak."""
    vector = embed(text)
    if not vector:
        return False
    full_payload = dict(payload or {})
    full_payload.setdefault("document", text)
    body = {
        "points": [
            {"id": _to_point_id(point_id), "vector": vector, "payload": full_payload}
        ]
    }
    try:
        _request(
            f"{QDRANT_URL}/collections/{collection}/points?wait=true",
            method="PUT", payload=body, timeout=_QDRANT_TIMEOUT,
        )
        return True
    except Exception as error:  # noqa: BLE001 — upsert je best-effort
        _logger.debug("memory_client.upsert(%s/%s): %s", collection, point_id, error)
        return False


def search(collection: str, text: str, k: int = 5,
           flt: dict | None = None) -> list[dict]:
    """Semantička pretraga: embeduj `text`, vrati do `k` najbližih tačaka iz
    `collection` kao `[{"id", "score", "payload"}, ...]`. `flt` je opcioni
    Qdrant filter (npr. `{"must": [{"key": "origin_domain",
    "match": {"value": "kalima"}}]}`). Tolerantno: bilo koja greška → `[]`."""
    vector = embed(text)
    if not vector:
        return []
    body: dict[str, Any] = {"vector": vector, "limit": k, "with_payload": True}
    if flt:
        body["filter"] = flt
    try:
        data = _request(
            f"{QDRANT_URL}/collections/{collection}/points/search",
            method="POST", payload=body, timeout=_QDRANT_TIMEOUT,
        )
        result = data.get("result") if isinstance(data, dict) else None
        if not isinstance(result, list):
            return []
        return [
            {"id": r.get("id"), "score": r.get("score"), "payload": r.get("payload") or {}}
            for r in result
        ]
    except Exception as error:  # noqa: BLE001 — search je best-effort
        _logger.debug("memory_client.search(%s): %s", collection, error)
        return []


# --------------------------------------------------------------------------
# CLI — ručna inicijalizacija/provera (`python3 memory_client.py init`)
# --------------------------------------------------------------------------
def _cli() -> None:
    import sys

    if len(sys.argv) < 2 or sys.argv[1] != "init":
        print("upotreba: python3 memory_client.py init", file=sys.stderr)
        raise SystemExit(2)
    results = memory_init()
    for name, ok in results.items():
        print(f"{'OK ' if ok else 'FAIL'}  {name}")
    if not all(results.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    _cli()

# --------------------------------------------------------------------------
# NAPOMENA (sinhronizacija kopija):
# Ovaj fajl je kanonski original. Lokalne kopije žive u:
#   ~/ai/domains/{kalima,codium,imperium,filmium}/core/cell/memory_client.py
# FILMIUM lokalna kopija čeka F: sync (vidi filmium-domains-setup.md) — ne
# dirati/gurati na F: automatski, samo lokalni Linux fajl je ažuriran.
# Menjaj OVDE pa ručno kopiraj dalje (isti fajl, bez izmena po domenu).
# --------------------------------------------------------------------------
