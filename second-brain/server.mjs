// ========== AI OS Second Brain — mali backend (Electron/HTTP zamena za Tauri) ==========
// Servira produkcioni build (dist/) i bezbedno čita atomske markdown fajlove sa
// diska. „Tauri invoke -> Rust" iz specifikacije je ovde HTTP: klijent šalje
// putanju atoma, backend je validira unutar dozvoljenih korena i vraća sirovi
// tekst (uključujući YAML frontmatter i [[linkove]]). Bez ijedne npm zavisnosti.
//
// Rute:
//   GET /api/atoms            -> lista atoma (id, title, domain, type) za Memory orbitu
//   GET /api/atom?path=<id>   -> { path, content, exists } jednog atoma
//   POST /api/approve         -> proxy ka domenu: gate osigurač ODOBRI (F7b)
//   POST /api/reject          -> proxy ka domenu: gate osigurač ODBIJ (F7b)
//   ostalo                    -> statički dist/ (SPA fallback na index.html)

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "dist");
const PORT = Number(process.env.SB_PORT || 4901);
const HOST = "127.0.0.1";

// Dozvoljeni koreni atoma (rootKey -> apsolutni folder). Sve van ovoga je 403.
const DOMAINS = ["kalima", "codium", "imperium", "filmium"];
const ROOTS = {
  global: path.join(HOME, "ai", "core-infrastructure", "vector-dbs", "global_graph_vault"),
};
for (const d of DOMAINS) ROOTS[d] = path.join(HOME, "ai", "domains", d, ".ai", "atomi");

// ---------- Gate approval proxy (F7b): GUI -> domen, bez CORS-a ----------
// Domen -> port ćelije (canonical, isti kao router-api).
const DOMAIN_PORTS = { filmium: 4801, codium: 4802, imperium: 4803, kalima: 4804 };

const MAX_ATOMS = 28; // koliko čvorova najviše na Memory orbiti (čitljivost)

// ---------- Ruter telemetrija (F7b stretch, "krvotok"): poslednji redovi route.log ----------
const ROUTE_LOG = path.join(HOME, ".cache", "ai-router", "route.log");
const ROUTE_LOG_MAX = 20;

async function readRouteLog(limit = ROUTE_LOG_MAX) {
  let raw = "";
  try {
    raw = await fsp.readFile(ROUTE_LOG, "utf8");
  } catch {
    return []; // ruter možda nije pokrenut / log još ne postoji — tiho prazna lista
  }
  const lines = raw.split("\n").filter(Boolean).slice(-limit);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* preskoči neispravan JSONL red */
    }
  }
  return out;
}

// ---------- Media (KORAK 6): Electron/HTTP zamena za Tauri convertFileSrc ----------
const MEDIA_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};
function mediaKind(ext) {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".mp4", ".webm", ".mov"].includes(ext)) return "video";
  return null;
}
const MEDIA_ROOTS = {};
for (const d of DOMAINS) {
  MEDIA_ROOTS[`${d}:ref`] = path.join(HOME, "ai", "domains", d, ".ai", "razvoj", "reference-slike");
  MEDIA_ROOTS[`${d}:shots`] = path.join(HOME, "ai", "domains", d, "data", "screenshots");
}
const MEDIA_PER_DOMAIN = 4; // koliko media-kartica po domenu (da ne zatrpa platno)

function walkMedia(baseDir) {
  const out = [];
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && mediaKind(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }
  return out.sort();
}

function listMedia() {
  const byDomain = new Map();
  for (const [rootKey, base] of Object.entries(MEDIA_ROOTS)) {
    const domain = rootKey.split(":")[0];
    for (const full of walkMedia(base)) {
      const list = byDomain.get(domain) ?? [];
      if (list.length >= MEDIA_PER_DOMAIN) break;
      const rel = path.relative(base, full).split(path.sep).join("/");
      list.push({
        id: `${rootKey}/${rel}`,
        path: `${rootKey}/${rel}`,
        kind: mediaKind(path.extname(full).toLowerCase()),
        name: path.basename(full),
        domain,
      });
      byDomain.set(domain, list);
    }
  }
  const out = [];
  for (const list of byDomain.values()) out.push(...list);
  return out;
}

function resolveMedia(token) {
  const idx = token.indexOf("/");
  const rootKey = idx < 0 ? token : token.slice(0, idx);
  const rel = idx < 0 ? "" : token.slice(idx + 1);
  const base = MEDIA_ROOTS[rootKey];
  if (!base) return { status: 400, error: "nepoznat media koren" };
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return { status: 403, error: "putanja van korena" };
  const mime = MEDIA_MIME[path.extname(full).toLowerCase()];
  if (!mime) return { status: 415, error: "nepodržan tip" };
  return { full, mime };
}

function serveMedia(req, res, token) {
  const r = resolveMedia(token);
  if (r.error) {
    res.writeHead(r.status);
    res.end(String(r.status));
    return;
  }
  fs.stat(r.full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end("404");
      return;
    }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416);
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": r.mime,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${st.size}`,
        "content-length": end - start + 1,
      });
      fs.createReadStream(r.full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "content-type": r.mime,
        "content-length": st.size,
        "accept-ranges": "bytes",
        "cache-control": "max-age=300",
      });
      fs.createReadStream(r.full).pipe(res);
    }
  });
}

function parseFrontTitleType(text) {
  let title = null;
  let type = null;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      for (const line of text.slice(3, end).split("\n")) {
        const m = /^(\w+):\s*(.+)$/.exec(line.trim());
        if (m && m[1] === "title") title = m[2].trim();
        if (m && m[1] === "type") type = m[2].trim();
      }
    }
  }
  return { title, type };
}

function stripFrontmatter(text) {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const nl = text.indexOf("\n", end + 1);
      return nl !== -1 ? text.slice(nl + 1) : "";
    }
  }
  return text;
}

function walkMd(baseDir) {
  const out = [];
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
  }
  return out.sort();
}

function listAtoms(full = false) {
  const atoms = [];
  for (const [rootKey, base] of Object.entries(ROOTS)) {
    for (const full of walkMd(base)) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      let text = "";
      try {
        text = fs.readFileSync(full, "utf8").slice(0, 4000);
      } catch {
        /* preskoči nečitljiv */
      }
      const { title, type } = parseFrontTitleType(text);
      const domain = rootKey === "global" ? "global" : rootKey;
      const nice = rel.replace(/\.md$/, "").split("/").join(" / ");
      const body = stripFrontmatter(text);
      const snippet = body.replace(/\s+/g, " ").trim().slice(0, 180);
      const links = [];
      const re = /\[\[([^\]]+)\]\]/g;
      let m;
      while ((m = re.exec(body)) !== null) links.push(m[1].trim());
      atoms.push({
        id: `${rootKey}/${rel}`,
        title: title || nice,
        domain,
        type: type || "note",
        snippet,
        links,
      });
    }
  }
  // Regioni znanja: vrati ceo skup (bez kapa) kad se traži ?full=1.
  if (full) return atoms;
  // Ravnomerno preseci po domenu do MAX_ATOMS (round-robin), za urednu orbitu.
  const byDomain = new Map();
  for (const a of atoms) {
    const list = byDomain.get(a.domain) ?? [];
    list.push(a);
    byDomain.set(a.domain, list);
  }
  const picked = [];
  let added = true;
  while (added && picked.length < MAX_ATOMS) {
    added = false;
    for (const list of byDomain.values()) {
      if (list.length) {
        picked.push(list.shift());
        added = true;
        if (picked.length >= MAX_ATOMS) break;
      }
    }
  }
  return picked;
}

// Validiraj token "rootKey/rel" -> apsolutna .md putanja unutar korena, ili greška.
function resolveAtom(token) {
  const idx = token.indexOf("/");
  const rootKey = idx < 0 ? token : token.slice(0, idx);
  const rel = idx < 0 ? "" : token.slice(idx + 1);
  const base = ROOTS[rootKey];
  if (!base) return { status: 400, error: "nepoznat koren atoma" };
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return { status: 403, error: "putanja van korena" };
  if (!full.endsWith(".md")) return { status: 403, error: "dozvoljeni su samo .md atomi" };
  return { full };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------- SSE event-hub (Electron/HTTP zamena za Tauri listen/emit) ----------
// Pozadina (router-api, domeni, alati poput Nuclei/ZAP) POST-uje događaj na
// /api/events; svi pretplaćeni GUI klijenti ga dobiju preko Server-Sent Events.
const sseClients = new Set();

function broadcastEvent(evt) {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      /* pukla veza — biće očišćena na 'close' */
    }
  }
}

function handleSseStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": ok\n\n"); // otvori tok
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("telo preveliko"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Heartbeat: komentar-linija na svakih 20s da veza (i proxy) ostane živa.
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }
}, 20000).unref();

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  let full = path.resolve(DIST, rel);
  if (full !== DIST && !full.startsWith(DIST + path.sep)) {
    res.writeHead(403);
    res.end("403");
    return;
  }
  try {
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) full = path.join(full, "index.html");
  } catch {
    full = path.join(DIST, "index.html"); // SPA fallback
  }
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("404");
  }
}

function askOllama(prompt, system) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: process.env.SB_MODEL || "qwen2.5:7b",
      prompt,
      system,
      stream: false,
    });
    const r = http.request(
      { host: "127.0.0.1", port: 11434, path: "/api/generate", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        timeout: 60000 },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          try {
            resolve(String(JSON.parse(Buffer.concat(chunks).toString("utf8")).response || "").trim());
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error("ollama timeout")));
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

// Prosledi ODOBRI/ODBIJ ka domenskoj ćeliji: POST /api/v1/<domain>/approvals/<gate_id>/<action>.
// Tolerantno: nedostajuća polja -> 400 sa jasnom porukom; domen ne odgovara -> 502 (server ne puca).
function proxyApproval(req, res, action) {
  readJsonBody(req)
    .then((body) => {
      const domain = String(body?.domain || "").trim();
      const gateId = String(body?.gate_id || body?.gateId || "").trim();
      if (!domain || !gateId) {
        sendJson(res, 400, { ok: false, error: "nedostaje domain ili gate_id" });
        return;
      }
      const port = DOMAIN_PORTS[domain];
      if (!port) {
        sendJson(res, 400, { ok: false, error: `nepoznat domen: ${domain}` });
        return;
      }
      const payload = JSON.stringify(
        action === "approve" ? { token: body?.token, note: body?.note } : { note: body?.note },
      );
      const targetPath = `/api/v1/${encodeURIComponent(domain)}/approvals/${encodeURIComponent(gateId)}/${action}`;
      const r = http.request(
        {
          host: "127.0.0.1",
          port,
          path: targetPath,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
          timeout: 5000,
        },
        (resp) => {
          const chunks = [];
          resp.on("data", (c) => chunks.push(c));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            res.writeHead(resp.statusCode || 200, {
              "content-type": resp.headers["content-type"] || "application/json; charset=utf-8",
            });
            res.end(raw || JSON.stringify({ ok: resp.statusCode < 400 }));
          });
        },
      );
      r.on("timeout", () => r.destroy(new Error("domen ne odgovara (timeout)")));
      r.on("error", (e) => {
        sendJson(res, 502, {
          ok: false,
          error: `domen ${domain} (port ${port}) ne odgovara: ${e.message || e}`,
          target: `http://127.0.0.1:${port}${targetPath}`,
        });
      });
      r.write(payload);
      r.end();
    })
    .catch((e) => sendJson(res, 400, { ok: false, error: String(e) }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (url.pathname === "/api/atoms") {
    try {
      const full = url.searchParams.get("full") === "1";
      sendJson(res, 200, { atoms: listAtoms(full) });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }
  if (url.pathname === "/api/atom") {
    const token = url.searchParams.get("path") || "";
    const r = resolveAtom(token);
    if (r.error) {
      sendJson(res, r.status, { path: token, exists: false, error: r.error });
      return;
    }
    try {
      const content = await fsp.readFile(r.full, "utf8");
      sendJson(res, 200, { path: token, exists: true, content });
    } catch (e) {
      const code = e && e.code === "ENOENT" ? 404 : e && e.code === "EACCES" ? 403 : 500;
      sendJson(res, code, {
        path: token,
        exists: false,
        error: code === 404 ? "atom ne postoji" : code === 403 ? "nema privilegija za čitanje" : String(e),
      });
    }
    return;
  }
  if (url.pathname === "/api/media-list") {
    try {
      sendJson(res, 200, { media: listMedia() });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }
  if (url.pathname === "/api/media") {
    serveMedia(req, res, url.searchParams.get("path") || "");
    return;
  }
  if (url.pathname === "/api/ask" && req.method === "POST") {
    try {
      const { path: token, question } = await readJsonBody(req);
      const r = resolveAtom(String(token || ""));
      if (r.error) {
        sendJson(res, r.status, { error: r.error });
        return;
      }
      const content = await fsp.readFile(r.full, "utf8").catch(() => "");
      if (!content) {
        sendJson(res, 404, { error: "atom ne postoji" });
        return;
      }
      const system =
        "Odgovaraj ISKLJUČIVO na osnovu datog dokumenta. Ako odgovor nije u njemu, " +
        "reci da nema u dokumentu. Kratko i na srpskom.";
      const prompt = `Dokument (${token}):\n"""\n${content.slice(0, 6000)}\n"""\n\nPitanje: ${String(question || "").slice(0, 500)}\nOdgovor:`;
      try {
        const answer = await askOllama(prompt, system);
        sendJson(res, 200, { answer: answer || "(prazan odgovor)" });
      } catch (e) {
        sendJson(res, 503, { error: `lokalni model nedostupan: ${e}` });
      }
    } catch (e) {
      sendJson(res, 400, { error: String(e) });
    }
    return;
  }
  if (url.pathname === "/api/routes") {
    try {
      sendJson(res, 200, { routes: await readRouteLog() });
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }
  if (url.pathname === "/api/approve" && req.method === "POST") {
    proxyApproval(req, res, "approve");
    return;
  }
  if (url.pathname === "/api/reject" && req.method === "POST") {
    proxyApproval(req, res, "reject");
    return;
  }
  if (url.pathname === "/api/events") {
    if (req.method === "GET") {
      handleSseStream(req, res);
      return;
    }
    if (req.method === "POST") {
      try {
        const evt = await readJsonBody(req);
        evt.ts = Date.now();
        broadcastEvent(evt);
        sendJson(res, 202, { ok: true, clients: sseClients.size });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e) });
      }
      return;
    }
    res.writeHead(405);
    res.end("405");
    return;
  }
  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[second-brain] http://${HOST}:${PORT}  (dist + /api/atoms, /api/atom)`);
});
