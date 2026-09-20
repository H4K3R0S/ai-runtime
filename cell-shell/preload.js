// preload — most između app-ovog TitleBar-a (Tauri stil) i Electron prozora.
// Radi u izolovanom svetu, ali deli DOM sa stranicom: hvata klik na
// .titlebar-minimize/-maximize/-close pre React/Tauri handlera i šalje IPC.
// Drag traka ([data-tauri-drag-region]) postaje native Electron drag zona.

const { contextBridge, ipcRenderer } = require("electron");

// OKO element/region birač — INLINE (preload je sandbox-ovan: `require("./...")`
// lokalnog modula ruši ceo preload, pa i TitleBar handlere). Deli DOM sa stranicom.
function okoStartPick(requestId, send, cancelKey) {
  const ov = document.createElement("div");
  Object.assign(ov.style, { position: "fixed", inset: "0", zIndex: 2147483647,
    cursor: "crosshair", background: "rgba(0,0,0,0.02)" });
  const hi = document.createElement("div");
  Object.assign(hi.style, { position: "fixed", pointerEvents: "none",
    border: "2px solid #33bfff", background: "rgba(51,191,255,0.12)", zIndex: 2147483647 });
  const hint = document.createElement("div");
  hint.textContent = "Klik = element · Prevuci = region · Esc / desni-klik = otkaži";
  Object.assign(hint.style, { position: "fixed", left: "50%", top: "12px", transform: "translateX(-50%)",
    zIndex: 2147483647, pointerEvents: "none", background: "rgba(5,7,13,0.9)", color: "#cbd5f5",
    font: "13px system-ui, sans-serif", padding: "6px 12px", borderRadius: "8px",
    border: "1px solid rgba(51,191,255,0.5)" });
  document.body.append(ov, hi, hint);
  const autoCancel = setTimeout(() => finish({ request_id: requestId, cancel: true }), 30000);

  let start = null;
  const rectFrom = (a, b) => ({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  const showHi = (r) => Object.assign(hi.style,
    { left: r.left + "px", top: r.top + "px", width: r.w + "px", height: r.h + "px" });

  function finish(payload) {
    clearTimeout(autoCancel);
    ov.remove(); hi.remove(); hint.remove();
    document.removeEventListener("keydown", onKey, true);
    send(payload);
  }
  function elAt(x, y) {
    ov.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    ov.style.pointerEvents = "auto";
    return el;
  }
  const cancelK = cancelKey || "Escape";
  const onKey = (e) => {
    if (e.key === cancelK || e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      finish({ request_id: requestId, cancel: true });
    }
  };

  ov.addEventListener("contextmenu", (e) => { e.preventDefault(); finish({ request_id: requestId, cancel: true }); });
  ov.addEventListener("mousedown", (e) => { if (e.button !== 0) return; start = { x: e.clientX, y: e.clientY }; });
  ov.addEventListener("mousemove", (e) => {
    if (start) { showHi(rectFrom(start, { x: e.clientX, y: e.clientY })); return; }
    const el = elAt(e.clientX, e.clientY);
    if (el) { const b = el.getBoundingClientRect(); showHi({ left: b.left, top: b.top, w: b.width, h: b.height }); }
  });
  ov.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    const end = { x: e.clientX, y: e.clientY };
    let r;
    if (start && (Math.abs(start.x - end.x) > 4 || Math.abs(start.y - end.y) > 4)) {
      r = rectFrom(start, end);
    } else {
      const el = elAt(end.x, end.y);
      if (!el) { start = null; return; }
      const b = el.getBoundingClientRect();
      r = { left: b.left, top: b.top, w: b.width, h: b.height };
    }
    start = null;
    if (r.w < 1 || r.h < 1) return;
    finish({ request_id: requestId, rect_viewport: { left: Math.round(r.left), top: Math.round(r.top),
      w: Math.round(r.w), h: Math.round(r.h) } });
  });
  document.addEventListener("keydown", onKey, true);
}

ipcRenderer.on("oko:pick", (_e, { request_id, cancel_key }) => {
  okoStartPick(request_id, (payload) => ipcRenderer.send("oko:pick-result", payload), cancel_key);
});


contextBridge.exposeInMainWorld("cellShell", {
  minimize: () => ipcRenderer.send("cell:minimize"),
  toggleMaximize: () => ipcRenderer.send("cell:toggle-maximize"),
  close: () => ipcRenderer.send("cell:close"),
});

window.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent =
    "[data-tauri-drag-region]{-webkit-app-region:drag}" +
    "[data-tauri-drag-region] button,[data-tauri-drag-region] a," +
    "[data-tauri-drag-region] input,.titlebar-button{-webkit-app-region:no-drag}";
  document.head.appendChild(style);

  const wire = () => {
    const map = [
      [".titlebar-minimize", "cell:minimize"],
      [".titlebar-maximize", "cell:toggle-maximize"],
      [".titlebar-close", "cell:close"],
    ];
    for (const [selector, channel] of map) {
      document.querySelectorAll(selector).forEach((btn) => {
        if (btn.__cellShell) return;
        btn.__cellShell = true;
        btn.addEventListener(
          "click",
          (e) => { e.preventDefault(); e.stopImmediatePropagation(); ipcRenderer.send(channel); },
          true,
        );
      });
    }
  };

  // Dupli klik na traku => toggle maximize (Linux to ne radi sam).
  document.addEventListener(
    "dblclick",
    (e) => {
      const region = e.target.closest("[data-tauri-drag-region]");
      if (region && !e.target.closest("button, a, input, .titlebar-button")) {
        ipcRenderer.send("cell:toggle-maximize");
      }
    },
    true,
  );

  wire();
  let n = 0;
  const iv = setInterval(() => { wire(); if (++n > 25) clearInterval(iv); }, 250);
});
