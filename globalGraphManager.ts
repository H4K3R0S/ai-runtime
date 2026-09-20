/**
 * globalGraphManager.ts
 * ------------------------------------------------------------------
 * Globalni "Second Brain" / Obsidian-stil graf na nivou celog OS-a.
 *
 * Upravlja malim, atomskim Markdown (.md) fajlovima sa YAML frontmatter-om
 * i Obsidian sintaksom za linkovanje ([[link]]). Služi kao globalni indeks
 * koji beleži veze između entiteta: Mete, IP adrese, YouTube skripte, Filmovi.
 *
 * NE dira kod Tauri domena. Samo postavlja globalnu bazu i API funkcije za
 * upis i čitanje atomskih fajlova.
 *
 * Vault lokacija:
 *   ~/ai/core-infrastructure/vector-dbs/global_graph_vault/
 *
 * Zavisnosti: samo Node.js standardna biblioteka (fs, path, os). Bez npm-a.
 * ------------------------------------------------------------------
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Tipovi entiteta koje graf prati. */
export type EntityType =
  | 'meta' // pentesting meta (host, domen)
  | 'ip' // IP adresa
  | 'youtube-script' // YouTube skripta
  | 'film' // Film
  | 'note' // generička beleška
  | string; // proširivo

/** YAML frontmatter atomskog fajla. */
export interface AtomFrontmatter {
  id: string; // jedinstveni slug (ime fajla bez .md)
  title: string; // ljudski čitljiv naslov
  type: EntityType; // tip entiteta
  tags?: string[]; // slobodni tagovi
  created: string; // ISO datum kreiranja
  updated: string; // ISO datum poslednje izmene
  aliases?: string[]; // alternativna imena
  [key: string]: unknown; // dodatna proizvoljna polja
}

/** Kompletan atomski čvor: frontmatter + telo + izvučeni linkovi. */
export interface AtomNode {
  frontmatter: AtomFrontmatter;
  body: string; // Markdown telo (bez frontmatter-a)
  links: string[]; // [[ciljevi]] pronađeni u telu
  filePath: string; // apsolutna putanja fajla
}

/** Ulaz za kreiranje/izmenu čvora. */
export interface AtomInput {
  id?: string; // ako se izostavi, generiše se iz naslova
  title: string;
  type: EntityType;
  body?: string;
  tags?: string[];
  aliases?: string[];
  extra?: Record<string, unknown>; // dodatna frontmatter polja
}

const DEFAULT_VAULT = path.join(
  os.homedir(),
  'ai',
  'core-infrastructure',
  'vector-dbs',
  'global_graph_vault',
);

const LINK_RE = /\[\[([^\]]+)\]\]/g;

export class GlobalGraphManager {
  readonly vaultDir: string;

  constructor(vaultDir: string = DEFAULT_VAULT) {
    this.vaultDir = vaultDir;
    this.ensureVault();
  }

  /** Napravi vault folder ako ne postoji. */
  private ensureVault(): void {
    fs.mkdirSync(this.vaultDir, { recursive: true });
  }

  /** Pretvori naslov u siguran slug za ime fajla. */
  static slugify(input: string): string {
    return input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // ukloni akcente
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'atom';
  }

  private pathFor(id: string): string {
    return path.join(this.vaultDir, `${id}.md`);
  }

  /** Minimalni YAML serializer (dovoljan za frontmatter). */
  private static toYaml(fm: AtomFrontmatter): string {
    const lines: string[] = [];
    const emit = (key: string, val: unknown) => {
      if (val === undefined || val === null) return;
      if (Array.isArray(val)) {
        if (val.length === 0) return;
        lines.push(`${key}:`);
        for (const item of val) lines.push(`  - ${GlobalGraphManager.yamlScalar(item)}`);
      } else {
        lines.push(`${key}: ${GlobalGraphManager.yamlScalar(val)}`);
      }
    };
    // stabilan redosled ključnih polja
    const ordered = ['id', 'title', 'type', 'tags', 'aliases', 'created', 'updated'];
    for (const k of ordered) if (k in fm) emit(k, (fm as Record<string, unknown>)[k]);
    for (const k of Object.keys(fm)) if (!ordered.includes(k)) emit(k, (fm as Record<string, unknown>)[k]);
    return lines.join('\n');
  }

  private static yamlScalar(v: unknown): string {
    const s = String(v);
    // navodnici ako ima specijalne karaktere
    if (/[:#\[\]{}",&*!|>'%@`]/.test(s) || s !== s.trim()) {
      return `"${s.replace(/"/g, '\\"')}"`;
    }
    return s;
  }

  /** Naivni YAML parser za frontmatter (ključ: vrednost i liste). */
  private static parseYaml(yaml: string): AtomFrontmatter {
    const fm: Record<string, unknown> = {};
    let currentKey: string | null = null;
    for (const raw of yaml.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const listItem = raw.match(/^\s+-\s+(.*)$/);
      if (listItem && currentKey) {
        (fm[currentKey] as unknown[]).push(GlobalGraphManager.unquote(listItem[1]));
        continue;
      }
      const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) {
        const [, key, val] = kv;
        if (val === '') {
          fm[key] = [];
          currentKey = key;
        } else {
          fm[key] = GlobalGraphManager.unquote(val);
          currentKey = null;
        }
      }
    }
    return fm as AtomFrontmatter;
  }

  private static unquote(s: string): string {
    const t = s.trim();
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"');
    return t;
  }

  /** Izvuci sve [[link]] ciljeve iz teksta. */
  static extractLinks(body: string): string[] {
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(body)) !== null) {
      // podrži [[cilj|alias]] -> uzmi cilj
      out.add(m[1].split('|')[0].trim());
    }
    return [...out];
  }

  // ---------------------------------------------------------------
  // API: upis
  // ---------------------------------------------------------------

  /** Kreiraj (ili prepiši) atomski čvor. Vraća zapisani AtomNode. */
  createAtom(input: AtomInput): AtomNode {
    const now = new Date().toISOString();
    const id = input.id ? GlobalGraphManager.slugify(input.id) : GlobalGraphManager.slugify(input.title);
    const filePath = this.pathFor(id);

    let created = now;
    if (fs.existsSync(filePath)) {
      // sačuvaj originalni created ako fajl već postoji
      try {
        created = this.readAtom(id).frontmatter.created ?? now;
      } catch {
        /* ignore */
      }
    }

    const frontmatter: AtomFrontmatter = {
      id,
      title: input.title,
      type: input.type,
      tags: input.tags,
      aliases: input.aliases,
      created,
      updated: now,
      ...(input.extra ?? {}),
    };

    const body = input.body ?? '';
    const content = `---\n${GlobalGraphManager.toYaml(frontmatter)}\n---\n\n${body}\n`;
    fs.writeFileSync(filePath, content, 'utf8');

    return { frontmatter, body, links: GlobalGraphManager.extractLinks(body), filePath };
  }

  /** Dodaj (append) tekst na telo postojećeg čvora. */
  appendToAtom(id: string, text: string): AtomNode {
    const node = this.readAtom(GlobalGraphManager.slugify(id));
    const newBody = `${node.body.trimEnd()}\n\n${text}`;
    return this.createAtom({
      id: node.frontmatter.id,
      title: node.frontmatter.title,
      type: node.frontmatter.type,
      body: newBody,
      tags: node.frontmatter.tags,
      aliases: node.frontmatter.aliases,
    });
  }

  /** Poveži dva čvora: doda [[to]] u telo `from` čvora (ako ga već nema). */
  linkAtoms(fromId: string, toId: string): AtomNode {
    const node = this.readAtom(GlobalGraphManager.slugify(fromId));
    const target = GlobalGraphManager.slugify(toId);
    if (node.links.includes(target)) return node;
    return this.appendToAtom(node.frontmatter.id, `- Povezano: [[${target}]]`);
  }

  // ---------------------------------------------------------------
  // API: čitanje
  // ---------------------------------------------------------------

  /** Pročitaj jedan čvor po id-u. Baca ako ne postoji. */
  readAtom(id: string): AtomNode {
    const filePath = this.pathFor(GlobalGraphManager.slugify(id));
    if (!fs.existsSync(filePath)) throw new Error(`Atom ne postoji: ${id}`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
      // fajl bez frontmatter-a — tretiraj ceo sadržaj kao telo
      return {
        frontmatter: { id, title: id, type: 'note', created: '', updated: '' },
        body: raw,
        links: GlobalGraphManager.extractLinks(raw),
        filePath,
      };
    }
    const frontmatter = GlobalGraphManager.parseYaml(match[1]);
    const body = match[2].trim();
    return { frontmatter, body, links: GlobalGraphManager.extractLinks(body), filePath };
  }

  /** Da li čvor postoji. */
  hasAtom(id: string): boolean {
    return fs.existsSync(this.pathFor(GlobalGraphManager.slugify(id)));
  }

  /** Lista svih id-eva u vault-u. */
  listAtoms(): string[] {
    return fs
      .readdirSync(this.vaultDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  }

  /** Učitaj sve čvorove. */
  readAll(): AtomNode[] {
    return this.listAtoms().map((id) => this.readAtom(id));
  }

  // ---------------------------------------------------------------
  // API: graf
  // ---------------------------------------------------------------

  /**
   * Izgradi graf veza: mapa id -> lista odlaznih linkova (outgoing).
   * Koristi se kao globalni indeks veza između entiteta.
   */
  buildGraph(): Record<string, string[]> {
    const graph: Record<string, string[]> = {};
    for (const node of this.readAll()) {
      graph[node.frontmatter.id] = node.links;
    }
    return graph;
  }

  /** Nađi sve čvorove koji linkuju ka datom id-u (backlinks). */
  backlinks(id: string): string[] {
    const target = GlobalGraphManager.slugify(id);
    return this.readAll()
      .filter((n) => n.links.includes(target))
      .map((n) => n.frontmatter.id);
  }

  /** Filtriraj čvorove po tipu entiteta. */
  byType(type: EntityType): AtomNode[] {
    return this.readAll().filter((n) => n.frontmatter.type === type);
  }
}

// Podrazumevana instanca za brzu upotrebu.
export const globalGraph = new GlobalGraphManager();

export default GlobalGraphManager;
