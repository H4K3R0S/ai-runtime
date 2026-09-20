/**
 * router.ts — Ultra-lagani, deterministički Event-Driven Router (Fallthrough Protokol).
 * ------------------------------------------------------------------------------
 * Deo OS-level AI infrastrukture. NE uvodi teške AI modele na ovom nivou —
 * samo determinističko rutiranje na osnovu statičkog manifesta + provera
 * globalnog grafa (globalGraphManager).
 *
 * Tok (Fallthrough Protokol):
 *   1. Domen ne može interno da reši zadatak -> šalje JSON zahtev ruteru.
 *   2. Ruter prvo proverava globalni graf (postoji li već zabeležena veza).
 *   3. Ruter iz manifesta određuje ciljani domen po `capability`.
 *   4. Prosleđuje zahtev ciljanom domenu (HTTP) i vraća odgovor.
 *   5. Hop Counter (max 3) sprečava kružne petlje i zagušenje CPU/RAM-a.
 *
 * Zavisnosti: samo Node.js stdlib (http, fs, path) + lokalni globalGraphManager.
 * ------------------------------------------------------------------------------
 */

import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { GlobalGraphManager } from '../globalGraphManager';

export interface DomainEntry {
  host: string;
  port: number;
  capabilities: string[];
  /** v2 (aditivno): canonical capability -> lista sinonima (srpski+engleski). Opciono. */
  capability_synonyms?: Record<string, string[]>;
}

export interface RoutingManifest {
  version: string;
  updated: string;
  router: { host: string; port: number; maxHops: number };
  domains: Record<string, DomainEntry>;
}

/** Zahtev koji domen šalje ruteru kada ne može interno da reši zadatak. */
export interface RouteRequest {
  capability: string; // tražena sposobnost (npr. "ip", "code", "film")
  query: string; // ljudski čitljiv upit / ključ
  payload?: unknown; // proizvoljni podaci za ciljani domen
  origin?: string; // domen koji je poslao zahtev (radi izbegavanja povratka)
  hops?: number; // trenutni broj skokova (interno)
  path?: string[]; // putanja domena kroz koje je prošao (radi detekcije petlji)
  packet_id?: string; // v2 (aditivno): opcioni identifikator paketa, koristi se za telemetriju
}

export interface RouteResponse {
  ok: boolean;
  from: 'graph-cache' | 'domain' | 'router';
  target?: string; // ciljani domen (ako je rutirano)
  hops: number;
  path: string[];
  data?: unknown; // odgovor domena ili keširana veza iz grafa
  error?: string;
}

/** Apstrakcija prosleđivanja ka domenu — injektabilna radi testiranja. */
export type Forwarder = (
  target: string,
  entry: DomainEntry,
  req: RouteRequest,
) => Promise<unknown>;

const MANIFEST_NAME = 'system_routing_manifest.json';

/** Nađi manifest tražeći ga naviše od date lokacije (robustno na dist/ nesting). */
function findManifest(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, MANIFEST_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Poslednji pokušaj: fiksna izvorna putanja.
  return path.join(os.homedir(), 'ai', 'core-infrastructure', 'router-api', MANIFEST_NAME);
}

const DEFAULT_MANIFEST = findManifest(__dirname);

/** v2: TTL negativnog keša (upiti koji su vratili prazno) — 10 minuta. */
const NEG_CACHE_TTL_MS = 10 * 60 * 1000;

/** v2: putanja JSONL telemetrije rutiranja. */
const DEFAULT_ROUTE_LOG = path.join(os.homedir(), '.cache', 'ai-router', 'route.log');

export class Router extends EventEmitter {
  readonly manifest: RoutingManifest;
  readonly maxHops: number;
  private readonly graph: GlobalGraphManager;
  private readonly forwarder: Forwarder;
  /** v2: negativni keš — slug upita -> timestamp poslednjeg praznog rezultata. */
  private readonly negCache = new Map<string, number>();
  private readonly routeLogPath: string;

  constructor(opts?: {
    manifestPath?: string;
    graph?: GlobalGraphManager;
    forwarder?: Forwarder;
    routeLogPath?: string;
  }) {
    super();
    this.manifest = Router.loadManifest(opts?.manifestPath ?? DEFAULT_MANIFEST);
    this.maxHops = this.manifest.router.maxHops ?? 3;
    this.graph = opts?.graph ?? new GlobalGraphManager();
    this.forwarder = opts?.forwarder ?? Router.httpForwarder;
    this.routeLogPath = opts?.routeLogPath ?? DEFAULT_ROUTE_LOG;
    this.ensureLogDir();
  }

  static loadManifest(p: string): RoutingManifest {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as RoutingManifest;
  }

  /** Deterministički odaberi domen po capability iz manifesta (prvi po abecedi ako ih ima više). */
  resolveTarget(capability: string, exclude?: string): string | null {
    const cap = capability.toLowerCase();
    const direct = this.matchByCapability(cap, exclude);
    if (direct) return direct;
    // v2: ako nema direktnog poklapanja, probaj preko capability_synonyms iz manifesta.
    return this.matchBySynonym(cap, exclude);
  }

  private matchByCapability(cap: string, exclude?: string): string | null {
    const candidates = Object.keys(this.manifest.domains)
      .filter((name) => name !== exclude)
      .filter((name) => this.manifest.domains[name].capabilities.map((c) => c.toLowerCase()).includes(cap))
      .sort(); // deterministički redosled
    return candidates[0] ?? null;
  }

  /**
   * v2: fallback rezolucija preko `capability_synonyms` (canonical ili sinonim -> domen).
   * I dalje deterministički (bez AI-ja): puko poklapanje stringova iz manifesta.
   */
  private matchBySynonym(cap: string, exclude?: string): string | null {
    const candidates = Object.keys(this.manifest.domains)
      .filter((name) => name !== exclude)
      .filter((name) => {
        const synonyms = this.manifest.domains[name].capability_synonyms;
        if (!synonyms) return false;
        return Object.entries(synonyms).some(([canonical, list]) => {
          if (canonical.toLowerCase() === cap) return true;
          return (list ?? []).some((s) => s.toLowerCase() === cap);
        });
      })
      .sort(); // deterministički redosled
    return candidates[0] ?? null;
  }

  /**
   * Proveri globalni graf: postoji li već atom čiji tip/id/tagovi odgovaraju upitu.
   * Deterministička provera — bez AI-ja. Vraća keširanu vezu ili null.
   */
  private checkGraph(req: RouteRequest): unknown | null {
    const slug = GlobalGraphManager.slugify(req.query);
    if (this.graph.hasAtom(slug)) {
      const node = this.graph.readAtom(slug);
      return {
        cachedAtom: node.frontmatter.id,
        type: node.frontmatter.type,
        links: node.links,
        backlinks: this.graph.backlinks(slug),
      };
    }
    // fallback: postoji li atom istog tipa kao tražena capability
    const byType = this.graph.byType(req.capability);
    if (byType.length > 0) {
      return { candidatesByType: byType.map((n) => n.frontmatter.id) };
    }
    return null;
  }

  /** v2: napravi direktorijum za route.log ako ne postoji (best-effort). */
  private ensureLogDir(): void {
    try {
      fs.mkdirSync(path.dirname(this.routeLogPath), { recursive: true });
    } catch {
      // best-effort — nedostupan direktorijum ne sme da obori ruter.
    }
  }

  /**
   * v2: upiši JSONL red telemetrije za jednu rutu. Best-effort: greška u logovanju
   * NIKAD ne sme da obori rutiranje (samo se guta, uz tihi fallback).
   */
  private logRoute(entry: {
    packet_id?: string;
    capability: string;
    from: string;
    to: string | null;
    hops: number;
    cache: 'graph' | 'neg' | 'none';
    result: 'hit' | 'empty';
    latency_ms: number;
  }): void {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      fs.appendFileSync(this.routeLogPath, line + '\n', 'utf8');
    } catch {
      // best-effort telemetrija — ignoriši grešku (npr. disk pun, dir obrisan).
    }
  }

  /** v2: brza TCP provera da li domen sluša na svom portu (za /health). Tolerantno na greške. */
  private checkDomainUp(entry: DomainEntry, timeoutMs = 300): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const socket = net.createConnection({ host: entry.host, port: entry.port });
      const finish = (up: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(up);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }

  /** v2: agregat za GET /health — status rutera + brza provera svakog domena (paralelno, tolerantno). */
  private async buildHealth(): Promise<Record<string, unknown>> {
    const names = Object.keys(this.manifest.domains);
    const checks = await Promise.all(
      names.map(async (name) => {
        const entry = this.manifest.domains[name];
        const up = await this.checkDomainUp(entry);
        return [name, { port: entry.port, up }] as const;
      }),
    );
    const domains: Record<string, { port: number; up: boolean }> = {};
    for (const [name, info] of checks) domains[name] = info;
    return {
      ok: true,
      router: { port: this.manifest.router.port, maxHops: this.maxHops },
      domains,
      uptime_s: Math.round(process.uptime()),
    };
  }

  /** Glavna tačka: obradi zahtev prema Fallthrough Protokolu. */
  async route(req: RouteRequest): Promise<RouteResponse> {
    const startedAt = Date.now();
    const hops = (req.hops ?? 0) + 1;
    const routePath = [...(req.path ?? []), req.origin ?? 'external'];
    const originLabel = req.origin ?? 'external';
    const slug = GlobalGraphManager.slugify(req.query ?? '');

    // v2: telemetrija — upiši jedan JSONL red pri svakom izlazu iz route() (best-effort).
    const finish = (
      resp: RouteResponse,
      cache: 'graph' | 'neg' | 'none',
      result: 'hit' | 'empty',
      to: string | null,
    ): RouteResponse => {
      this.logRoute({
        packet_id: req.packet_id,
        capability: req.capability,
        from: originLabel,
        to,
        hops: resp.hops,
        cache,
        result,
        latency_ms: Date.now() - startedAt,
      });
      return resp;
    };

    this.emit('route', { req, hops });

    // 0) v2: Negativni keš — ako je isti upit (slugify) skoro vratio prazno, vrati prazno ODMAH (bez hopa/forwarda).
    const negTs = this.negCache.get(slug);
    if (negTs !== undefined && Date.now() - negTs < NEG_CACHE_TTL_MS) {
      const resp: RouteResponse = {
        ok: false,
        from: 'router',
        hops,
        path: routePath,
        error: `Negativni keš: upit "${req.query}" je nedavno (< ${Math.round(NEG_CACHE_TTL_MS / 60000)} min) vratio prazno.`,
      };
      this.emit('neg-cache-hit', resp);
      return finish(resp, 'neg', 'empty', null);
    }

    // Hop Counter — zaštita od kružnih petlji i zagušenja.
    if (hops > this.maxHops) {
      const resp: RouteResponse = {
        ok: false,
        from: 'router',
        hops,
        path: routePath,
        error: `Hop limit prekoračen (max ${this.maxHops}). Prekidam da sprečim petlju.`,
      };
      this.emit('reject', resp);
      return finish(resp, 'none', 'empty', null);
    }

    // 1) Provera globalnog grafa (keš veza) — pre bilo kakvog prosleđivanja.
    const cached = this.checkGraph(req);
    if (cached) {
      const resp: RouteResponse = { ok: true, from: 'graph-cache', hops, path: routePath, data: cached };
      this.emit('graph-hit', resp);
      this.negCache.delete(slug); // v2: uspešan pogodak čisti eventualni stari negativni keš.
      return finish(resp, 'graph', 'hit', null);
    }

    // 2) Determinističko rutiranje po manifestu (uključujući v2 capability_synonyms fallback).
    const target = this.resolveTarget(req.capability, req.origin);
    if (!target) {
      const resp: RouteResponse = {
        ok: false,
        from: 'router',
        hops,
        path: routePath,
        error: `Nijedan domen ne nudi capability "${req.capability}".`,
      };
      this.emit('reject', resp);
      this.negCache.set(slug, Date.now()); // v2: zabeleži prazan rezultat za negativni keš.
      return finish(resp, 'none', 'empty', null);
    }

    // Detekcija petlje: ako je ciljani domen već u putanji.
    if (routePath.includes(target)) {
      const resp: RouteResponse = {
        ok: false,
        from: 'router',
        target,
        hops,
        path: routePath,
        error: `Detektovana petlja: "${target}" je već u putanji.`,
      };
      this.emit('reject', resp);
      return finish(resp, 'none', 'empty', target);
    }

    // 3) Prosledi ciljanom domenu.
    const entry = this.manifest.domains[target];
    this.emit('forward', { target, hops, path: routePath });
    try {
      const data = await this.forwarder(target, entry, { ...req, hops, path: [...routePath, target] });
      const resp: RouteResponse = { ok: true, from: 'domain', target, hops, path: [...routePath, target], data };
      this.emit('response', resp);
      if (data) {
        this.negCache.delete(slug); // v2: uspešan rezultat čisti negativni keš.
      } else {
        this.negCache.set(slug, Date.now()); // v2: domen je odgovorio, ali bez podataka — prazno.
      }
      return finish(resp, 'none', data ? 'hit' : 'empty', target);
    } catch (err) {
      // Napomena: mrežna/infra greška (npr. domen ugašen) se NAMERNO ne upisuje u negativni keš —
      // to je privremeno stanje domena, ne odsustvo rešenja za capability, pa ne sme da "otruje"
      // sledeće identične upite na 10 minuta.
      const resp: RouteResponse = {
        ok: false,
        from: 'router',
        target,
        hops,
        path: [...routePath, target],
        error: `Prosleđivanje ka "${target}" nije uspelo: ${(err as Error).message}`,
      };
      this.emit('error-response', resp);
      return finish(resp, 'none', 'empty', target);
    }
  }

  /** Podrazumevani forwarder: HTTP POST ka domenu na /solve. */
  static httpForwarder: Forwarder = (target, entry, req) =>
    new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(req), 'utf8');
      const r = http.request(
        {
          host: entry.host,
          port: entry.port,
          path: '/solve',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': body.length },
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch {
              resolve(text);
            }
          });
        },
      );
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', reject);
      r.write(body);
      r.end();
    });

  /** Pokreni HTTP server rutera (endpoint POST /route). */
  listen(port = this.manifest.router.port, host = this.manifest.router.host): http.Server {
    const server = http.createServer((httpReq, httpRes) => {
      // v2: GET /health — agregatni status rutera + domena. Postojeći POST /route ostaje netaknut.
      if (httpReq.method === 'GET' && httpReq.url === '/health') {
        this.buildHealth()
          .then((body) => {
            httpRes.writeHead(200, { 'content-type': 'application/json' });
            httpRes.end(JSON.stringify(body));
          })
          .catch((err) => {
            // Tolerantno: čak i pad agregata vraća graciozan JSON, ne ruši ruter.
            httpRes.writeHead(200, { 'content-type': 'application/json' });
            httpRes.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          });
        return;
      }

      if (httpReq.method !== 'POST' || httpReq.url !== '/route') {
        httpRes.writeHead(404, { 'content-type': 'application/json' });
        httpRes.end(JSON.stringify({ ok: false, error: 'Koristi POST /route ili GET /health' }));
        return;
      }
      const chunks: Buffer[] = [];
      httpReq.on('data', (c) => chunks.push(c as Buffer));
      httpReq.on('end', async () => {
        try {
          const req = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RouteRequest;
          const resp = await this.route(req);
          httpRes.writeHead(resp.ok ? 200 : 422, { 'content-type': 'application/json' });
          httpRes.end(JSON.stringify(resp));
        } catch (err) {
          httpRes.writeHead(400, { 'content-type': 'application/json' });
          httpRes.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
      });
    });
    server.listen(port, host, () => this.emit('listening', { host, port }));
    return server;
  }
}

export default Router;

// Ako se pokrene direktno: podigni server.
if (require.main === module) {
  const router = new Router();
  router.on('listening', ({ host, port }) => console.log(`[router] sluša na http://${host}:${port}/route (maxHops=${router.maxHops})`));
  router.on('graph-hit', (r) => console.log(`[router] graph-cache pogodak (hops=${r.hops})`));
  router.on('neg-cache-hit', (r) => console.log(`[router] negativni keš pogodak (hops=${r.hops})`));
  router.on('forward', (f) => console.log(`[router] prosleđujem -> ${f.target} (hops=${f.hops})`));
  router.on('reject', (r) => console.log(`[router] odbijeno: ${r.error}`));
  router.listen();
}
