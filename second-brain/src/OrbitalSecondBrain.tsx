// ========== OrbitalSecondBrain — orbitalni Second Brain (ARMS) ==========
// KORAK 1: stabilan Canvas render + rotacija (rAF, cos/sin).
// KORAK 2: raycasting + klik -> svetleće relacione linije ka zavisnim čvorovima.
// KORAK 3: klik na Memory čvor -> onInspect (File Inspector sidebar).
// KORAK 4: SSE događaji (`/api/events`) -> RAĐANJE čvorova uživo: nov čvor se
//   „rodi" u centru i interpolira ka svojoj orbiti, uz privremenu svetleću liniju
//   ka roditelju/meti. Cap po orbiti (teški skenovi ne naduvaju niz) + uredan
//   unlisten na unmount.

import { useEffect, useRef, useState } from "react";

import { subscribeDomainEvents, type DomainEvent } from "./domainEvents";
import { loadOrbitalData } from "./orbitalData";
import type { OrbitalData, OrbitalNode, OrbitKey } from "./types";

const ORBIT_COLOR: Record<OrbitKey, string> = {
  applications: "#4f9df0",
  routines: "#e3b341",
  memory: "#b57be0",
  skills: "#ff9d57",
};

const ORBITS: ReadonlyArray<{
  key: OrbitKey;
  label: string;
  radius: number;
  speed: number;
  dir: 1 | -1;
}> = [
  { key: "applications", label: "APPLICATIONS", radius: 0.9, speed: 0.05, dir: 1 },
  { key: "routines", label: "ROUTINES", radius: 0.66, speed: 0.08, dir: -1 },
  { key: "memory", label: "MEMORY", radius: 0.44, speed: 0.12, dir: 1 },
  { key: "skills", label: "SKILLS", radius: 0.22, speed: 0.18, dir: -1 },
];

const EMPTY: OrbitalData = { applications: [], routines: [], memory: [], skills: [] };
const TWO_PI = Math.PI * 2;
const NODE_R = 5;
const HIT_R = 14;
const FLIGHT_MS = 1000; // trajanje „rađanja" (interpolacija iz centra na orbitu)
const MAX_SPAWN_PER_ORBIT = 24; // gornja granica živorođenih čvorova po orbiti

const TYPE_TO_ORBIT: Record<string, OrbitKey> = {
  memory: "memory",
  routine: "routines",
  routines: "routines",
  app: "applications",
  application: "applications",
  applications: "applications",
  skill: "skills",
  skills: "skills",
};
function typeToOrbit(type: string): OrbitKey {
  return TYPE_TO_ORBIT[type] ?? "memory";
}

interface FramePoint {
  node: OrbitalNode;
  x: number;
  y: number;
  color: string;
}

interface Spawn {
  node: OrbitalNode;
  bornMs: number;
  parentId: string | null;
}

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildGroupIndex(data: OrbitalData): Map<string, string[]> {
  const all = [...data.applications, ...data.routines, ...data.memory, ...data.skills];
  const byGroup = new Map<string, string[]>();
  for (const n of all) {
    if (!n.group) continue;
    const list = byGroup.get(n.group) ?? [];
    list.push(n.id);
    byGroup.set(n.group, list);
  }
  return byGroup;
}

function relatedFor(
  data: OrbitalData,
  groupIndex: Map<string, string[]>,
  selected: OrbitalNode,
): Set<string> {
  if (selected.group) {
    const ids = new Set(groupIndex.get(selected.group) ?? []);
    ids.delete(selected.id);
    return ids;
  }
  return new Set(data.applications.map((a) => a.id));
}

// Roditelj živorođenog čvora: nađi po id-u ili labeli (event.parent), inače
// padни na aplikaciju domena (`app:<domen>`).
function resolveParentId(data: OrbitalData, spawns: Spawn[], event: DomainEvent): string | null {
  if (event.parent) {
    const all: OrbitalNode[] = [
      ...data.applications,
      ...data.routines,
      ...data.memory,
      ...data.skills,
      ...spawns.map((s) => s.node),
    ];
    const hit = all.find((n) => n.id === event.parent || n.label === event.parent);
    if (hit) return hit.id;
  }
  return event.domain ? `app:${event.domain}` : null;
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  p: FramePoint,
  opts: { alpha: number; scale: number; ring: boolean; showLabel: boolean },
): void {
  const { x, y, color } = p;
  const rNode = NODE_R * opts.scale;
  ctx.globalAlpha = opts.alpha;

  const glow = ctx.createRadialGradient(x, y, 0, x, y, rNode * 3);
  glow.addColorStop(0, hexA(color, 0.9));
  glow.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, rNode * 3, 0, TWO_PI);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, rNode, 0, TWO_PI);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1;
  ctx.stroke();

  if (opts.ring) {
    ctx.strokeStyle = hexA(color, 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, rNode + 4, 0, TWO_PI);
    ctx.stroke();
  }

  if (opts.showLabel) {
    ctx.fillStyle = "rgba(233, 240, 247, 0.92)";
    ctx.font = "500 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(truncate(p.node.label, 16), x, y + rNode + 3);
  }
  ctx.globalAlpha = 1;
}

function drawLink(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
): void {
  ctx.strokeStyle = hexA(color, 0.14);
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.strokeStyle = hexA(color, 0.85);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawCore(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number): void {
  const pulse = 1 + Math.sin(t * 1.5) * 0.08;
  const rCore = 14 * pulse;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, rCore * 4);
  glow.addColorStop(0, hexA("#ff9d57", 0.85));
  glow.addColorStop(1, hexA("#ff9d57", 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, rCore * 4, 0, TWO_PI);
  ctx.fill();

  ctx.fillStyle = "#ff9d57";
  ctx.beginPath();
  ctx.arc(cx, cy, rCore, 0, TWO_PI);
  ctx.fill();

  ctx.fillStyle = "rgba(11, 16, 32, 0.92)";
  ctx.font = "700 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("AI OS", cx, cy);
}

export interface OrbitalInspectTarget {
  path: string;
  label: string;
}

interface OrbitalSecondBrainProps {
  onInspect?: (atom: OrbitalInspectTarget) => void;
}

export default function OrbitalSecondBrain({ onInspect }: OrbitalSecondBrainProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onInspectRef = useRef(onInspect);
  onInspectRef.current = onInspect;
  const dataRef = useRef<OrbitalData>(EMPTY);
  const groupIndexRef = useRef<Map<string, string[]>>(new Map());
  const mouseRef = useRef<{ x: number; y: number; inside: boolean }>({ x: 0, y: 0, inside: false });
  const framesRef = useRef<Map<string, FramePoint>>(new Map());
  const selectRef = useRef<string | null>(null);
  const relatedRef = useRef<Set<string>>(new Set());
  const spawnsRef = useRef<Spawn[]>([]);
  const [ready, setReady] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    loadOrbitalData(ctrl.signal).then((data) => {
      dataRef.current = data;
      groupIndexRef.current = buildGroupIndex(data);
      setReady(true);
    });
    return () => ctrl.abort();
  }, []);

  // KORAK 4: SSE događaji -> rađanje čvorova. Unsubscribe (unlisten) na unmount.
  useEffect(() => {
    const unsub = subscribeDomainEvents((event) => {
      const orbit = typeToOrbit(event.type);
      const ts = event.ts ?? Date.now();
      const node: OrbitalNode = {
        id: `spawn:${event.domain}:${event.type}:${event.label}:${ts}`,
        label: event.label,
        orbit,
        group: event.domain && event.domain !== "global" ? event.domain : undefined,
        meta: event.path ? { path: event.path } : undefined,
      };
      const parentId = resolveParentId(dataRef.current, spawnsRef.current, event);
      if (node.group) {
        const list = groupIndexRef.current.get(node.group) ?? [];
        list.push(node.id);
        groupIndexRef.current.set(node.group, list);
      }
      const spawns = spawnsRef.current;
      spawns.push({ node, bornMs: performance.now(), parentId });
      // Cap po orbiti (FIFO) — zaštita od preopterećenja tokom skenova.
      let count = 0;
      for (const s of spawns) if (s.node.orbit === orbit) count += 1;
      if (count > MAX_SPAWN_PER_ORBIT) {
        const idx = spawns.findIndex((s) => s.node.orbit === orbit);
        if (idx >= 0) spawns.splice(idx, 1);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = true;
    let cssW = 0;
    let cssH = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      cssW = Math.max(1, rect.width);
      cssH = Math.max(1, rect.height);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const pick = (mx: number, my: number): FramePoint | null => {
      let best: FramePoint | null = null;
      let bestD = HIT_R * HIT_R;
      for (const p of framesRef.current.values()) {
        const dx = p.x - mx;
        const dy = p.y - my;
        const d = dx * dx + dy * dy;
        if (d <= bestD) {
          bestD = d;
          best = p;
        }
      }
      return best;
    };

    const toCanvas = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };

    const onMove = (ev: MouseEvent) => {
      const { x, y } = toCanvas(ev);
      mouseRef.current = { x, y, inside: true };
    };
    const onLeave = () => {
      mouseRef.current.inside = false;
    };
    const onClick = (ev: MouseEvent) => {
      const { x, y } = toCanvas(ev);
      const hit = pick(x, y);
      if (!hit || selectRef.current === hit.node.id) {
        selectRef.current = null;
        relatedRef.current = new Set();
        setSelectedLabel(null);
        return;
      }
      selectRef.current = hit.node.id;
      relatedRef.current = relatedFor(dataRef.current, groupIndexRef.current, hit.node);
      setSelectedLabel(hit.node.label);
      const atomPath = hit.node.meta?.path;
      if (hit.node.orbit === "memory" && typeof atomPath === "string") {
        onInspectRef.current?.({ path: atomPath, label: hit.node.label });
      }
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);

    const draw = (tMs: number) => {
      if (!running) return;
      const t = tMs / 1000;
      const cx = cssW / 2;
      const cy = cssH / 2;
      // Nikad negativan poluprečnik: pri (re)montiranju/resize-u kanvas može
      // nakratko biti ~0px (getBoundingClientRect pre layout-a), pa bi
      // Math.min(cx, cy) - 28 postao negativan i srušio createRadialGradient /
      // arc (IndexSizeError). Kad je platno degenerisano, preskoči frejm — rAF
      // se nastavlja i oporavi se čim ResizeObserver javi prave dimenzije.
      const R = Math.max(0, Math.min(cx, cy) - 28);
      if (R <= 0) {
        ctx.clearRect(0, 0, cssW, cssH);
        raf = requestAnimationFrame(draw);
        return;
      }

      ctx.clearRect(0, 0, cssW, cssH);

      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.1);
      bg.addColorStop(0, "rgba(255, 157, 87, 0.10)");
      bg.addColorStop(1, "rgba(11, 16, 32, 0)");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.1, 0, TWO_PI);
      ctx.fill();

      // Živorođeni čvorovi (spawn) po orbiti + vreme rođenja.
      const spawns = spawnsRef.current;
      const bornById = new Map<string, number>();
      for (const s of spawns) bornById.set(s.node.id, s.bornMs);

      // 1) Žive pozicije SVIH čvorova (bazni + spawn), sa interpolacijom rođenja.
      const frames = framesRef.current;
      frames.clear();
      for (const orbit of ORBITS) {
        const r = R * orbit.radius;
        const color = ORBIT_COLOR[orbit.key];
        const base = dataRef.current[orbit.key];
        const extra = spawns.filter((s) => s.node.orbit === orbit.key).map((s) => s.node);
        const list = extra.length ? [...base, ...extra] : base;
        const n = list.length;
        if (n === 0) continue;
        const baseRot = orbit.dir * t * orbit.speed;
        for (let i = 0; i < n; i += 1) {
          const node = list[i];
          const angle = baseRot + (i / n) * TWO_PI;
          let x = cx + r * Math.cos(angle);
          let y = cy + r * Math.sin(angle);
          const born = bornById.get(node.id);
          if (born !== undefined) {
            const age = tMs - born;
            if (age < FLIGHT_MS) {
              const k = age / FLIGHT_MS;
              const e = 1 - (1 - k) * (1 - k); // easeOutQuad
              x = cx + (x - cx) * e;
              y = cy + (y - cy) * e;
            }
          }
          frames.set(node.id, { node, x, y, color });
        }
      }

      // 2) Prstenovi + labele orbita.
      for (const orbit of ORBITS) {
        const r = R * orbit.radius;
        const color = ORBIT_COLOR[orbit.key];
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TWO_PI);
        ctx.strokeStyle = hexA(color, 0.18);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = hexA(color, 0.72);
        ctx.font = "600 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(orbit.label, cx, cy - r - 6);
      }

      // 3) Privremene svetleće linije rađanja (spawn -> roditelj), blede.
      for (const s of spawns) {
        const age = tMs - s.bornMs;
        if (age >= FLIGHT_MS) continue;
        const p = frames.get(s.node.id);
        if (!p) continue;
        const a = 1 - age / FLIGHT_MS;
        const parent = s.parentId ? frames.get(s.parentId) : null;
        if (parent) {
          ctx.strokeStyle = hexA("#ffffff", 0.55 * a);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(parent.x, parent.y);
          ctx.stroke();
        }
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 16);
        g.addColorStop(0, hexA(ORBIT_COLOR[s.node.orbit], 0.5 * a));
        g.addColorStop(1, hexA(ORBIT_COLOR[s.node.orbit], 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16, 0, TWO_PI);
        ctx.fill();
      }

      // 4) Raycasting hover + selekcija/relacije.
      const hover = mouseRef.current.inside
        ? pick(mouseRef.current.x, mouseRef.current.y)
        : null;
      const selId = selectRef.current;
      const related = relatedRef.current;
      const selPoint = selId ? frames.get(selId) ?? null : null;
      canvas.style.cursor = hover ? "pointer" : "default";

      if (selPoint) {
        for (const id of related) {
          const target = frames.get(id);
          if (target) drawLink(ctx, selPoint.x, selPoint.y, target.x, target.y, selPoint.color);
        }
      }

      // 5) Čvorovi.
      for (const p of frames.values()) {
        const isSel = p.node.id === selId;
        const isRel = related.has(p.node.id);
        const isHover = hover?.node.id === p.node.id;
        const dim = selId && !isSel && !isRel;
        const born = bornById.get(p.node.id);
        const freshSpawn = born !== undefined && tMs - born < 2500;
        drawNode(ctx, p, {
          alpha: dim ? 0.22 : 1,
          scale: isSel ? 1.6 : isHover ? 1.3 : 1,
          ring: isSel || isHover,
          showLabel: isSel || isRel || isHover || freshSpawn || frames.size <= 12,
        });
      }

      drawCore(ctx, cx, cy, t);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="orbital-wrap">
      <canvas ref={canvasRef} className="orbital-canvas" />
      {!ready && <div className="orbital-hint">Učitavam kontekst…</div>}
      {selectedLabel && (
        <div className="orbital-selection">
          <span className="orbital-selection__dot" />
          {selectedLabel}
          <span className="orbital-selection__hint">klik na prazno = deselekcija</span>
        </div>
      )}
    </div>
  );
}
