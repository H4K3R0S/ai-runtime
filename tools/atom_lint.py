#!/usr/bin/env python3
"""atom_lint.py — validator atomskih fajlova (Global Atom OS, standard v2).

Proverava da li `.md` atomski fajlovi poštuju atomski standard v2
(`01-atomski-standard-v2.md` / `ATOMIC-CONTENT.md`): frontmatter postoji,
obavezna polja su tu, `id == slugify(title)` (kritično za ruter graf-keš),
`type` je poznat, i izlistava `[[linkove]]` iz tela.

Samo Python stdlib — bez zavisnosti. Poruke na srpskom (latinica).

Upotreba:
    python3 atom_lint.py <putanja-ili-dir>...   # rekurzivno skenira *.md
    python3 atom_lint.py                        # podrazumevano: 4 domena + globalni vault
    python3 atom_lint.py --warn-only            # sve kao WARN, exit 0
    python3 atom_lint.py --quiet                # samo problemi + sažetak (bez OK/INFO linija)

Exit kod: nenula ako ima bar jedan ERROR (osim sa --warn-only → uvek 0).
"""
from __future__ import annotations

import re
import sys
import unicodedata
from pathlib import Path

# ---------------------------------------------------------------------------
# slugify — MORA biti identičan originalima (id se poklapa sa ruter graf-kešom):
#   - Python: ~/ai/domains/kalima/core/cell/fallthrough.py :: slugify
#   - JS:     ~/ai/core-infrastructure/globalGraphManager.ts :: GlobalGraphManager.slugify
# NE MENJATI bez sinhronizacije sa oba originala.
# ---------------------------------------------------------------------------


def slugify(text: str) -> str:
    """Identično `fallthrough.slugify()`: NFKD, skini akcente (č→c, ž→z, š→s),
    mala slova, sve što nije [a-z0-9] -> '-', trim '-', max 80 karaktera."""
    norm = unicodedata.normalize("NFKD", text)
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    norm = re.sub(r"[^a-z0-9]+", "-", norm.lower()).strip("-")[:80]
    return norm or "atom"


# ---------------------------------------------------------------------------
# Poznati `type` — standard v2 (01-atomski-standard-v2.md, po domenu) +
# legacy iz ATOMIC-CONTENT.md + šabloni (07-SABLONI/*). Nepoznat type = WARN
# (lista je namerno proširiva, ne blokira).
# ---------------------------------------------------------------------------
KNOWN_TYPES = {
    # os / deljeno
    "note", "skill", "log", "learn", "entity", "tool", "command", "persona",
    # codium
    "code_snapshot", "repo", "pipeline", "deployment", "automation", "cve", "exploit",
    # filmium
    "media_entry", "subtitle", "collection", "person", "bookmark",
    # imperium
    "market_analysis", "video_production", "niche", "competitor", "asset", "seo_keyword",
    # kalima
    "target_asset", "port_node", "finding", "evidence", "ioc", "malware_sample",
    "incident", "forensic_note",
    # legacy (ATOMIC-CONTENT.md) / plan
    "meta", "ip", "youtube-script", "film", "code", "recon", "orchestration", "target",
    # meta-atomi (šabloni, dokumentacija sistema)
    "reference", "spec",
}

REQUIRED_FIELDS = ("id", "title", "type")

# Funkcionalni atomi se učitavaju po FIKSNOM id-ju (agent ih zove po imenu:
# persona „komandant", tool „kalima-tool-hash"…) i NISU meta ruter-lookupa po
# slugify(upit). Zato je za njih id != slugify(title) samo WARN, ne ERROR.
# Znanjski atomi (note/learn/entity/domensko znanje) MORAJU imati id==slug.
FUNCTIONAL_TYPES = {"persona", "tool", "command", "skill"}

_LINK_RE = re.compile(r"\[\[([^\]|#]+)")
_LIST_INLINE_RE = re.compile(r"^\[(.*)\]$")
_KV_RE = re.compile(r"^([A-Za-z0-9_\-]+):\s*(.*)$")


def _strip_quotes(s: str) -> str:
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    return s


def parse_frontmatter(text: str) -> tuple[dict[str, object] | None, str]:
    """Prost parser YAML frontmatter-a: `ključ: vrednost`, inline liste `[a,b]`
    ili YAML liste sa `- ` linijama. BEZ ugnježdenih mapa — dublje uvučeni
    `ključ: vrednost` blokovi se preskaču (po standardu idu u telo, pod svojom
    zonom). Vraća (frontmatter-dict ili None ako fajl nema frontmatter, telo).
    """
    if not text.startswith("---"):
        return None, text
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return None, text

    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return None, text

    fm_lines = lines[1:end_idx]
    body = "\n".join(lines[end_idx + 1:])

    data: dict[str, object] = {}
    current_key: str | None = None
    for raw in fm_lines:
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        indented = raw[:1] in (" ", "\t")
        stripped = raw.strip()

        if indented and stripped.startswith("- "):
            # nastavak YAML liste za current_key
            if current_key is not None:
                val = _strip_quotes(stripped[2:].strip())
                existing = data.get(current_key)
                if isinstance(existing, list):
                    existing.append(val)
                else:
                    data[current_key] = [val]
            continue

        if indented:
            # ugnježdena mapa — van dogovora za frontmatter, preskoči (ignoriši red)
            continue

        m = _KV_RE.match(stripped)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        current_key = key

        if val == "":
            # moguće da sledi YAML lista sa '- ' u narednim linijama
            data[key] = ""
            continue

        inline_list = _LIST_INLINE_RE.match(val)
        if inline_list:
            items = [
                _strip_quotes(x.strip())
                for x in inline_list.group(1).split(",")
                if x.strip() != ""
            ]
            data[key] = items
        else:
            data[key] = _strip_quotes(val)

    return data, body


def extract_links(body: str) -> list[str]:
    return [m.strip() for m in _LINK_RE.findall(body)]


class Issue:
    __slots__ = ("severity", "message")

    def __init__(self, severity: str, message: str) -> None:
        self.severity = severity  # "ERROR" | "WARN"
        self.message = message


def lint_file(path: Path) -> tuple[list[Issue], int]:
    """Validira jedan atom fajl. Vraća (lista problema, broj [[linkova]] u telu).
    Nikad ne baca izuzetak napolje — neispravan fajl ne sme srušiti ceo run."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as error:  # noqa: BLE001 — po dizajnu: 1 fajl ne ruši run
        return [Issue("ERROR", f"Ne mogu da pročitam fajl: {error}")], 0

    text = text.replace("\r\n", "\n").replace("\r", "\n")

    try:
        fm, body = parse_frontmatter(text)
    except Exception as error:  # noqa: BLE001
        return [Issue("ERROR", f"Parsiranje frontmatter-a nije uspelo: {error}")], 0

    if fm is None:
        return [Issue(
            "ERROR",
            "Nema YAML frontmatter-a (fajl mora početi sa '---' i imati zatvarajuće '---')",
        )], 0

    issues: list[Issue] = []

    for field in REQUIRED_FIELDS:
        val = fm.get(field)
        if val is None or (isinstance(val, str) and val.strip() == ""):
            issues.append(Issue("ERROR", f"Nedostaje obavezno polje '{field}'"))

    _type_str = fm.get("type") if isinstance(fm.get("type"), str) else ""
    atom_id = fm.get("id")
    title = fm.get("title")
    if isinstance(atom_id, str) and atom_id and isinstance(title, str) and title:
        expected = slugify(title)
        if atom_id != expected:
            _funkcionalni = _type_str in FUNCTIONAL_TYPES
            issues.append(Issue(
                "WARN" if _funkcionalni else "ERROR",
                f"id ('{atom_id}') ne odgovara slugify(title)-u — id treba da bude: {expected}"
                + ("  [funkcionalni tip: fiksni id je dozvoljen, ali title/id ujednači radi pretrage]"
                   if _funkcionalni else "  [znanjski atom: ruter ga traži po slug-u → OBAVEZNO]"),
            ))

    atom_type = fm.get("type")
    if isinstance(atom_type, str) and atom_type and atom_type not in KNOWN_TYPES:
        issues.append(Issue(
            "WARN",
            f"nepoznat type '{atom_type}' (nije u standardnoj listi standarda v2 — proveri tipfeler ili dopuni listu)",
        ))

    try:
        links = extract_links(body)
    except Exception:  # noqa: BLE001
        links = []

    return issues, len(links)


def iter_md_files(paths: list[Path]) -> list[Path]:
    files: list[Path] = []
    seen: set[Path] = set()
    for p in paths:
        try:
            if p.is_file() and p.suffix == ".md":
                rp = p.resolve()
                if rp not in seen:
                    seen.add(rp)
                    files.append(p)
            elif p.is_dir():
                for f in sorted(p.rglob("*.md")):
                    rp = f.resolve()
                    if rp not in seen:
                        seen.add(rp)
                        files.append(f)
            else:
                print(f"[atom_lint] upozorenje: putanja ne postoji, preskačem: {p}", file=sys.stderr)
        except Exception as error:  # noqa: BLE001 — skeniranje ne sme da padne
            print(f"[atom_lint] upozorenje: greška pri skeniranju '{p}': {error}", file=sys.stderr)
    return files


def default_paths() -> list[Path]:
    home = Path.home()
    return [
        home / "ai/domains/kalima/.ai/atomi",
        home / "ai/domains/codium/.ai/atomi",
        home / "ai/domains/filmium/.ai/atomi",
        home / "ai/domains/imperium/.ai/atomi",
        home / "ai/core-infrastructure/vector-dbs/global_graph_vault",
    ]


def main(argv: list[str]) -> int:
    warn_only = "--warn-only" in argv
    quiet = "--quiet" in argv
    positional = [a for a in argv if not a.startswith("--")]

    paths = [Path(a) for a in positional] if positional else default_paths()
    files = iter_md_files(paths)

    if not files:
        print("[atom_lint] Nijedan .md fajl nije pronađen za skeniranje.")
        return 0

    total_errors = 0
    total_warns = 0
    clean_files = 0

    for f in files:
        try:
            issues, link_count = lint_file(f)
        except Exception as error:  # noqa: BLE001 — apsolutna poslednja linija odbrane
            issues = [Issue("ERROR", f"Neočekivana greška pri lintovanju: {error}")]
            link_count = 0

        if warn_only:
            for issue in issues:
                issue.severity = "WARN"

        file_errors = sum(1 for i in issues if i.severity == "ERROR")
        file_warns = sum(1 for i in issues if i.severity == "WARN")
        total_errors += file_errors
        total_warns += file_warns

        if not issues:
            clean_files += 1
            if not quiet:
                print(f"OK   {f} ({link_count} [[linkova]])")
            continue

        print(f"--   {f}")
        for issue in issues:
            print(f"     {issue.severity}: {issue.message}")
        if not quiet:
            print(f"     INFO: {link_count} [[linkova]] u telu")

    print()
    print(
        f"[atom_lint] Sažetak: {len(files)} fajlova, {clean_files} čisto, "
        f"{total_errors} ERROR, {total_warns} WARN"
    )

    if warn_only:
        return 0
    return 1 if total_errors > 0 else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
