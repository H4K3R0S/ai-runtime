// cell-shell — generički Electron (Chromium) prozor za ćelije (FILMIUM/CODIUM/IMPERIUM/KALIMA).
// Zamena za WebKit2GTK prozor na Linuxu: isti engine kao Windows WebView2 (Tauri),
// pa teški CSS efekti (blur/glass) idu ~4x brže nego u WebKitGTK na NVIDIA.
//
// Upotreba: electron <ovaj-dir> <putanja-do-ćelije> --no-sandbox
// Čita cell.json (port, name, domain_id), diže uvicorn iz venv-a ćelije ako port nije zauzet
// (ako jeste — koristi postojeći server i ne gasi ga), otvara FRAMELESS maksimizovan prozor,
// veže app-ove TitleBar dugmiće + drag traku (preload.js), a zatvaranje prozora gasi i server.
//
// Dijagnostika: SVE (argv, izabrana ćelija, spawn servera, uvicorn stdout/stderr, učitavanje
// stranice, gašenje) ide u ~/.cache/cell-shell/<domain_id>.log (prethodni log -> .log.prev)
// i na stderr. Profil (cache, localStorage) je odvojen po ćeliji: ~/.config/cell-shell/<domain_id>.

const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { viewportToDevice } = require("./oko-geometry");

// ---------- OKO element-birač (pametan Insert): long-poll ka OKO :4807 ----------
function okoPost(pathname, body) {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: "127.0.0.1", port: 4807, path: pathname, method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": data.length } });
  req.on("error", () => {});
  req.end(data);
}
function startOkoPickLoop(w) {
  let stopped = false;
  w.on("closed", () => { stopped = true; });
  const pid = process.pid;
  const poll = () => {
    if (stopped) return;
    const req = http.get({ host: "127.0.0.1", port: 4807, path: `/pick/wait?pid=${pid}`, timeout: 30000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { const d = JSON.parse(buf || "{}"); if (d.action === "pick" && !w.isDestroyed()) w.webContents.send("oko:pick", { request_id: d.request_id, cancel_key: d.cancel_key || "Escape" }); } catch (e) {}
        setImmediate(poll);
      });
    });
    req.on("error", () => setTimeout(poll, 1000));
    req.on("timeout", () => { req.destroy(); setImmediate(poll); });
  };
  poll();
}
ipcMain.on("oko:pick-result", (event, payload) => {
  try {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (payload && payload.cancel) { okoPost("/pick/result", { request_id: payload.request_id, cancel: true }); return; }
    const cb = w.getContentBounds();
    const sf = (screen.getDisplayMatching(cb).scaleFactor) || 1;
    const rect = viewportToDevice(payload.rect_viewport, cb, sf);
    okoPost("/pick/result", { request_id: payload.request_id, rect });
  } catch (e) {}
});

// ---------- ćelija ----------
function findCellDir() {
  // argv u Electronu: [electron, <shell-dir>, <cell-dir>, --flags...] — uzmi prvi argument
  // koji sadrži cell.json, pa $CELL_DIR, pa cwd. Bez cell.json ne znamo ni port ni venv.
  const candidates = [
    ...process.argv.slice(1).filter((a) => !a.startsWith("-")),
    process.env.CELL_DIR,
    process.cwd(),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, "cell.json")).isFile()) return path.resolve(c);
    } catch {}
  }
  return null;
}
const CELL_DIR = findCellDir();
let CFG = {};
let cfgError = null;
if (CELL_DIR) {
  try {
    CFG = JSON.parse(fs.readFileSync(path.join(CELL_DIR, "cell.json"), "utf8"));
  } catch (e) {
    cfgError = String(e);
  }
}
const HOST = "127.0.0.1";
const PORT = Number(CFG.port || 8000);
const NAME = CFG.name || "Ćelija";
const DOMAIN = CFG.domain_id || (CELL_DIR ? path.basename(CELL_DIR).toLowerCase() : "cell");
const URL = `http://${HOST}:${PORT}`;
const freshUrl = () => `${URL}/?_cb=${Date.now()}`; // svež GUI posle rebuild-a

// ---------- log ----------
const LOG_DIR = path.join(os.homedir(), ".cache", "cell-shell");
const LOG_FILE = path.join(LOG_DIR, `${DOMAIN}.log`);
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  try { process.stderr.write(line); } catch {}
}
function rotateLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, `${LOG_FILE}.prev`);
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- server ----------
function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: PORT });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(400, () => done(false));
  });
}
function httpUp() {
  // HTTP status (0 = ne odgovara). Port može biti zauzet dok uvicorn još učitava app.
  return new Promise((resolve) => {
    const req = http.get(`${URL}/`, { timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error", () => resolve(0));
  });
}
function venvPython() {
  for (const c of [".venv/bin/python", ".venv-linux/bin/python"]) {
    const p = path.join(CELL_DIR, c);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return "python3";
}
let server = null;      // uvicorn koji smo MI pokrenuli (null ako koristimo tuđi)
let serverDied = false; // naš uvicorn je izašao pre nego što je odgovorio
async function startServer() {
  if (await portOpen()) {
    log(`port ${PORT} je već otvoren — koristim postojeći server (neću ga gasiti)`);
    return;
  }
  const py = venvPython();
  const args = ["-m", "uvicorn", "cell_app:app", "--host", HOST, "--port", String(PORT)];
  log(`spawn: ${py} ${args.join(" ")}  (cwd=${CELL_DIR})`);
  let out = "ignore";
  try { out = fs.openSync(LOG_FILE, "a"); } catch {}
  let child = null;
  try {
    child = spawn(py, args, {
      cwd: CELL_DIR,
      detached: true, // svoja procesna grupa -> gasimo uvicorn + njegovu decu odjednom
      stdio: ["ignore", out, out], // uvicorn stdout/stderr -> log fajl
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
  } catch (e) {
    log("spawn NIJE uspeo:", e.message);
  }
  if (typeof out === "number") { try { fs.closeSync(out); } catch {} }
  if (!child) return;
  server = child;
  child.on("error", (e) => { log("server greška:", e.message); if (server === child) { server = null; serverDied = true; } });
  child.on("exit", (code, sig) => {
    log(`server pid ${child.pid} izašao (code=${code} signal=${sig})`);
    if (server === child) { server = null; serverDied = true; }
  });
  child.unref();
  log(`server pid ${child.pid}; čekam ${URL} ...`);
}
async function waitForServer(maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const code = await httpUp();
    if (code) { log(`server odgovara (HTTP ${code}) posle ${Date.now() - t0} ms`); return true; }
    if (serverDied) { log("server je umro pre nego što je odgovorio — vidi uvicorn izlaz iznad"); return false; }
    await sleep(250);
  }
  log(`server ne odgovara posle ${maxMs} ms — otvaram prozor svejedno (retry pri did-fail-load)`);
  return false;
}
function alive(child) {
  return child && child.pid && child.exitCode === null && child.signalCode === null;
}
function killGroup(child, sig) {
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
}
async function stopServer() {
  const child = server;
  server = null;
  if (!alive(child)) return;
  log(`gasim server pid ${child.pid} (SIGTERM grupi)`);
  killGroup(child, "SIGTERM");
  for (let i = 0; i < 12; i++) { // do 3 s
    if (!alive(child)) { log("server ugašen"); return; }
    await sleep(250);
  }
  log("server nije stao na SIGTERM — SIGKILL");
  killGroup(child, "SIGKILL");
}

// ---------- prozor ----------
let win = null;
function createWindow() {
  const iconPath = path.join(CELL_DIR, `${DOMAIN}-icon.png`);
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false, // seamless: bez OS naslovne trake/okvira (app crta svoj TitleBar)
    backgroundColor: "#0b1020",
    show: false,
    title: NAME,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const wc = win.webContents;

  let shown = false;
  const show = (why) => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    log(`prikazujem prozor (${why})`);
    win.maximize();
    win.show();
  };
  win.once("ready-to-show", () => show("ready-to-show"));
  setTimeout(() => show("timeout 6 s — stranica se nije javila"), 6000);

  // WM naslov ostaje ime ćelije (stranica postavlja svoj <title>), da se prozor nađe po imenu.
  win.on("page-title-updated", (e) => e.preventDefault());

  let loadRetries = 0;
  wc.on("did-fail-load", (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED (prekinuta navigacija), nije greška
    log(`did-fail-load ${code} ${desc} ${url}`);
    if (++loadRetries <= 40 && !win.isDestroyed()) setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(freshUrl()); }, 1500);
  });
  wc.on("did-finish-load", () => log("did-finish-load", wc.getURL()));
  wc.on("render-process-gone", (e, d) => log(`render-process-gone: ${d.reason} (exitCode ${d.exitCode})`));
  wc.on("preload-error", (e, p, err) => log(`preload-error ${p}: ${err && err.message}`));
  wc.on("console-message", (e, level, message, line, sourceId) => {
    const lvl = typeof level === "number" ? level : ({ verbose: 0, info: 1, warning: 2, error: 3 }[e.level] ?? 1);
    if (lvl >= 3) log(`console[error] ${message} (${sourceId}:${line})`);
  });

  win.on("closed", () => { win = null; shutdown("prozor zatvoren"); });
  win.loadURL(freshUrl());
  startOkoPickLoop(win);
}

let shuttingDown = false;
function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`zatvaram (${why})`);
  stopServer().finally(() => app.quit());
}

// TitleBar most (preload.js šalje ove kanale)
ipcMain.on("cell:minimize", () => { if (win) win.minimize(); });
ipcMain.on("cell:toggle-maximize", () => { if (win) (win.isMaximized() ? win.unmaximize() : win.maximize()); });
ipcMain.on("cell:close", () => { if (win) win.close(); });

app.on("window-all-closed", () => shutdown("window-all-closed"));
app.on("will-quit", () => { if (alive(server)) killGroup(server, "SIGTERM"); }); // poslednja linija odbrane
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(sig));
process.on("uncaughtException", (e) => log("uncaughtException:", (e && e.stack) || e));

// ---------- start ----------
async function main() {
  rotateLog();
  log(`start: argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}`);
  log(`ćelija: ${NAME} (${DOMAIN}) dir=${CELL_DIR} port=${PORT} python=${venvPython()} userData=${app.getPath("userData")}`);
  await app.whenReady();
  log(`electron ${process.versions.electron} / chrome ${process.versions.chrome}; DISPLAY=${process.env.DISPLAY || "?"}`);
  await startServer();
  await waitForServer(40000);
  createWindow();
}

// Profil po ćeliji + jedna instanca po ćeliji (drugi start samo fokusira postojeći prozor).
app.setPath("userData", path.join(app.getPath("appData"), "cell-shell", DOMAIN));
if (!CELL_DIR || cfgError) {
  const msg = !CELL_DIR
    ? `cell.json nije nađen.\nargv=${JSON.stringify(process.argv)}\ncwd=${process.cwd()}`
    : `cell.json u ${CELL_DIR} nije čitljiv: ${cfgError}`;
  process.stderr.write(`cell-shell: ${msg}\n`);
  app.whenReady().then(() => { dialog.showErrorBox("cell-shell", msg); app.exit(2); });
} else if (!app.requestSingleInstanceLock()) {
  process.stderr.write(`cell-shell: ${NAME} već radi — fokusiram postojeći prozor.\n`);
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  main().catch((e) => { log("main greška:", (e && e.stack) || e); app.exit(1); });
}
