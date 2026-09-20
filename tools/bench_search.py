#!/usr/bin/env python3
# core-infrastructure/tools/bench_search.py
# ==========          MERNI HARNESS ZA HIBRIDNU PRETRAGU (F2)          ==========
# Meri kvalitet i brzinu F1 hibridne pretrage (`HybridRetriever`/`fts_index`)
# nad zlatnim setom stvarnih upita po domenu. SAMO Python stdlib. NE menja
# domenski kod — samo čita atome (indirektno, preko `fts_index.rebuild()`) i
# poziva već izgrađeni `HybridRetriever`/`fts_index` iz ćelije.
#
# v. UNAPREDJENJE/01-ARHITEKTURA/09-performanse-i-odziv.md (budžet, "Merenje")
#    UNAPREDJENJE/01-ARHITEKTURA/02-hibridna-pretraga.md ([DoD])
#
# VAŽNO — svaki domen ima SVOJE `core/` stablo i SVOJ venv, pa se ovo MORA
# pokrenuti IZ KORENA domena, sa NJEGOVIM venv-om (ne dele isti sys.path):
#
#   cd ~/ai/domains/kalima  && .venv/bin/python        <ova_skripta> kalima
#   cd ~/ai/domains/codium  && .venv/bin/python        <ova_skripta> codium
#   cd ~/ai/domains/filmium && .venv-linux/bin/python  <ova_skripta> filmium
#
# Zlatni set: core-infrastructure/tools/golden/<domen>.json
#   [{"query": "...", "expect_id": "<id atoma koji treba da bude u top-3>"}, ...]
from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path
from typing import NoReturn

_TOOLS_DIR = Path(__file__).resolve().parent
_GOLDEN_DIR = _TOOLS_DIR / "golden"

# Budžet (v. 09-performanse-i-odziv.md / 02-hibridna-pretraga.md).
_BUDGET_FTS_P95_MS = 50.0
_BUDGET_HYBRID_P95_MS = 300.0
_BUDGET_TOP3_HIT_PCT = 90.0

_TOP_K = 3  # "top-3 hit" — v. [DoD] u 02-hibridna-pretraga.md


def _fail(msg: str) -> NoReturn:
    print(f"GREŠKA: {msg}", file=sys.stderr)
    raise SystemExit(1)


def _load_golden(domain: str) -> list[dict]:
    path = _GOLDEN_DIR / f"{domain}.json"
    if not path.exists():
        _fail(
            f"zlatni set ne postoji: {path}\n"
            f"       (za 'imperium' je ovo očekivano — 0 atoma u F0, pa je F2 preskočen za taj domen)"
        )
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except Exception as error:  # noqa: BLE001
        _fail(f"zlatni set nije validan JSON ({path}): {error}")
    if not isinstance(data, list) or not data:
        _fail(f"zlatni set je prazan ili nije lista upita: {path}")
    out: list[dict] = []
    for i, item in enumerate(data):
        if not isinstance(item, dict) or "query" not in item or "expect_id" not in item:
            _fail(f"stavka #{i} u {path} nema oba polja 'query'/'expect_id': {item!r}")
        out.append({"query": str(item["query"]), "expect_id": str(item["expect_id"])})
    return out


def _percentile(values: list[float], pct: float) -> float:
    """Nearest-rank interpolacioni percentil, bez spoljnih zavisnosti.
    `pct` u [0, 100]. Prazna lista -> 0.0 (nema uzoraka -> ništa za prijaviti,
    poziv koda dalje odlučuje šta to znači)."""
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (pct / 100.0) * (len(s) - 1)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)


def _fmt_ms(x: float) -> str:
    return f"{x:.2f} ms"


def _budget_line(label: str, value: float, budget: float, *, higher_is_better: bool = False) -> None:
    ok = (value >= budget) if higher_is_better else (value <= budget)
    mark = "OK  " if ok else "FAIL"
    unit = "%" if higher_is_better else "ms"
    cmp_sym = ">=" if higher_is_better else "<="
    print(f"  [{mark}] {label:24s} izmereno={value:.2f}{unit}  (budžet {cmp_sym} {budget:g}{unit})")


def _import_domain_modules(domain: str, cwd: Path):
    """Uvozi `core.domains.<domain>.search.{fts_index,hybrid_retriever}` iz
    KORENA domena (mora biti trenutni radni direktorijum — svaki domen ima
    odvojeno `core/` stablo pa ne postoji jedan zajednički import put)."""
    if str(cwd) not in sys.path:
        sys.path.insert(0, str(cwd))
    try:
        fts_index = __import__(
            f"core.domains.{domain}.search.fts_index", fromlist=["fts_index"]
        )
    except Exception as error:  # noqa: BLE001
        script = Path(__file__).resolve()
        _fail(
            f"import core.domains.{domain}.search.fts_index nije uspeo iz {cwd} ({error}).\n"
            f"       Pokreni IZ KORENA domena, sa NJEGOVIM venv-om, npr.:\n"
            f"       cd ~/ai/domains/{domain} && .venv/bin/python {script} {domain}"
        )
    try:
        hybrid_mod = __import__(
            f"core.domains.{domain}.search.hybrid_retriever",
            fromlist=["HybridRetriever"],
        )
    except Exception as error:  # noqa: BLE001
        _fail(f"import core.domains.{domain}.search.hybrid_retriever nije uspeo: {error}")
    return fts_index, hybrid_mod.HybridRetriever


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        _fail("upotreba: bench_search.py <domen>   (pokreni IZ KORENA tog domena, sa njegovim venv-om)")
    domain = argv[1].strip()
    if not domain:
        _fail("prazan naziv domena")

    cwd = Path.cwd()
    golden = _load_golden(domain)
    fts_index, HybridRetriever = _import_domain_modules(domain, cwd)

    print(f"=== bench_search: {domain} ===")
    print(f"koren:      {cwd}")
    print(f"python:     {sys.executable}")
    print(f"zlatni set: {len(golden)} upita  ({_GOLDEN_DIR / (domain + '.json')})")

    # --- rebuild() indeksa (uvek sveže stanje pre merenja, v. spec [1]) ---
    t0 = time.perf_counter()
    try:
        n_indexed = fts_index.rebuild()
    except Exception as error:  # noqa: BLE001 — rebuild se ne sme srušiti run
        n_indexed = 0
        print(f"UPOZORENJE: fts_index.rebuild() je bacio izuzetak: {error}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    rebuild_ms = (time.perf_counter() - t0) * 1000.0
    print(f"rebuild():  {n_indexed} atoma indeksirano za {_fmt_ms(rebuild_ms)}")

    if n_indexed == 0:
        print(
            "UPOZORENJE: indeks je prazan (0 atoma) — svi upiti će promašiti top-3. "
            "Proveri da li domen uopšte ima atome u .ai/atomi/.",
            file=sys.stderr,
        )

    try:
        retriever = HybridRetriever(domain, k=_TOP_K)
    except Exception as error:  # noqa: BLE001
        _fail(f"HybridRetriever({domain!r}, k={_TOP_K}) konstrukcija nije uspela: {error}")

    # Zagrevanje: prvi `retrieve()` u procesu lenjo gradi/sinhronizuje FTS
    # indeks (`_ensure_index`) — taj jednokratni trošak se NE računa u p50/p95
    # (isto važi za realan proces: plaća se jednom, ne po upitu).
    try:
        t = time.perf_counter()
        retriever.retrieve("__bench_warmup__")
        warmup_ms = (time.perf_counter() - t) * 1000.0
        print(f"warmup:     prvi retrieve() (indeks + eventualni vektor) za {_fmt_ms(warmup_ms)} (ne računa se)")
    except Exception as error:  # noqa: BLE001
        print(f"UPOZORENJE: warmup retrieve() je bacio izuzetak: {error}", file=sys.stderr)

    fts_latencies_ms: list[float] = []
    hybrid_latencies_ms: list[float] = []
    hits = 0            # HIBRID top-3 pogoci (primarna metrika)
    fts_hits_count = 0  # FTS top-3 pogoci (referenca)
    misses: list[dict] = []
    errors: list[dict] = []

    for item in golden:
        query = item["query"]
        expect_id = item["expect_id"]

        # (a) čist FTS: latencija + top-3 id provera (fts_index.search vraća id).
        fts_ids: list[str] = []
        try:
            t = time.perf_counter()
            fts_hits = fts_index.search(query, k=_TOP_K)
            fts_latencies_ms.append((time.perf_counter() - t) * 1000.0)
            fts_ids = [h.get("id") for h in fts_hits]
        except Exception as error:  # noqa: BLE001 — jedan upit ne sme srušiti run
            errors.append({"query": query, "phase": "fts_index.search", "error": str(error)})
            traceback.print_exc(file=sys.stderr)

        # (b) HIBRID: latencija punog `rank()` (FTS + vektor + RRF + rerank) +
        # top-3 preko id-jeva iz FUZOVANOG rezultata — ono što sistem STVARNO
        # koristi (ne samo FTS). `rank()` radi isti posao kao `retrieve()`, pa je
        # jedan poziv i za latenciju i za top-3.
        hyb_ids: list[str] = []
        try:
            t = time.perf_counter()
            ranked = retriever.rank(query)
            hybrid_latencies_ms.append((time.perf_counter() - t) * 1000.0)
            hyb_ids = [h.get("id") for h in ranked[:_TOP_K]]
        except Exception as error:  # noqa: BLE001
            errors.append({"query": query, "phase": "HybridRetriever.rank", "error": str(error)})
            traceback.print_exc(file=sys.stderr)

        # Primarna top-3 metrika = HIBRID; FTS top-3 se broji kao referenca.
        if expect_id in hyb_ids:
            hits += 1
        else:
            misses.append({"query": query, "expect_id": expect_id,
                           "hybrid_top3": hyb_ids, "fts_top3": fts_ids})
        if expect_id in fts_ids:
            fts_hits_count += 1

    total = len(golden)
    hit_pct = (hits / total * 100.0) if total else 0.0

    fts_p50 = _percentile(fts_latencies_ms, 50)
    fts_p95 = _percentile(fts_latencies_ms, 95)
    hyb_p50 = _percentile(hybrid_latencies_ms, 50)
    hyb_p95 = _percentile(hybrid_latencies_ms, 95)

    print()
    print("--- Rezultati ---")
    print(f"upita ukupno:      {total}")
    fts_hit_pct = (fts_hits_count / total * 100.0) if total else 0.0
    print(f"top-3 hit (HIBRID):        {hits}/{total}  ({hit_pct:.1f}%)")
    print(f"top-3 hit (samo FTS, ref): {fts_hits_count}/{total}  ({fts_hit_pct:.1f}%)")
    print(f"FTS5    p50 / p95: {_fmt_ms(fts_p50)} / {_fmt_ms(fts_p95)}  (n={len(fts_latencies_ms)})")
    print(f"Hibrid  p50 / p95: {_fmt_ms(hyb_p50)} / {_fmt_ms(hyb_p95)}  (n={len(hybrid_latencies_ms)})")

    print()
    print("--- Budžet ---")
    _budget_line("FTS5 p95 < 50 ms", fts_p95, _BUDGET_FTS_P95_MS)
    _budget_line("Hibrid p95 < 300 ms", hyb_p95, _BUDGET_HYBRID_P95_MS)
    _budget_line("Top-3 hit(HIBRID) >= 90%", hit_pct, _BUDGET_TOP3_HIT_PCT, higher_is_better=True)

    if misses:
        print()
        print(f"--- Promašaji top-3 ({len(misses)}/{total}) ---")
        for m in misses:
            print(f"  upit={m['query']!r:46s} expect_id={m['expect_id']!r:26s}")
            print(f"      hibrid_top3={m['hybrid_top3']}   (fts_top3={m['fts_top3']})")

    if errors:
        print()
        print(f"--- Izuzeci po upitu ({len(errors)}) — nisu srušili run ---")
        for e in errors:
            print(f"  [{e['phase']}] upit={e['query']!r}: {e['error']}")

    print()
    all_ok = (fts_p95 <= _BUDGET_FTS_P95_MS) and (hyb_p95 <= _BUDGET_HYBRID_P95_MS) and (hit_pct >= _BUDGET_TOP3_HIT_PCT)
    print("REZULTAT: SVI BUDžETI ISPUNJENI" if all_ok else "REZULTAT: BAR JEDAN BUDžET NIJE ISPUNJEN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
