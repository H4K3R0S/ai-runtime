// ========== RegionsView — „Regioni znanja" (radijalni prikaz po domenima) ==========
// Adaptacija FILMIUM koncepta BrainRegions za CENTRALNI AI OS Second Brain.
// Regioni = AI-OS DOMENI (filmium / codium / imperium / kalima / global), svaki
// kao isečak prstena (ring segment) sa razmakom. Svaki region prikazuje top-N
// atoma po KOMBINOVANOM skoru (veze [[wikilink]] + veličina snippet-a + tip).
// Klik na region -> drill-down: SVI atomi regiona u koncentričnim pod-prstenovima.
// Nazad dugme vraća na pregled, hover pokazuje tooltip.
//
// Izvor podataka: /api/atoms?full=1 (server.mjs). Sve je TOLERANTNO — prazni ili
// nedostupni podaci ne ruše render.

import { useEffect, useMemo, useState } from "react";

import type { OrbitalInspectTarget } from "./OrbitalSecondBrain";

// ---------- Geometrija (SVG radijalni raspored) ----------
const CX = 500;
const CY = 500;
const CORE_R = 58;

const REGION_COLORS: Record<string, string> = {
  filmium: "#f472b6",
  codium: "#4f9df0",
  imperium: "#e3b341",
  kalima: "#34d399",
  global: "#b57be0",
};
function colorFor(key: string, i: number): string {
  return REGION_COLORS[key] ?? `hsl(${(i * 67) % 360} 72% 62%)`;
}

function polar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

/** Isečak prstena (ring segment) sa unutrašnjim/spoljnim radijusom. */
function segPath(rIn: number, rOut: number, a0: number, a1: number): string {
  const [x0o, y0o] = polar(rOut, a0);
  const [x1o, y1o] = polar(rOut, a1);
  const [x0i, y0i] = polar(rIn, a0);
  const [x1i, y1i] = polar(rIn, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0o} ${y0o} A ${rOut} ${rOut} 0 ${large} 1 ${x1o} ${y1o} `
    + `L ${x1i} ${y1i} A ${rIn} ${rIn} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

// ---------- Model ----------
interface ApiAtom {
  id: string;
  title: string;
  domain: string;
  type: string;
  snippet?: string;
  links?: string[];
}

interface RegionNode {
  id: string;
  label: string;
  score: number; // 0..1 (normalizovano u okviru regiona)
  conn: number; // broj [[wikilink]] veza
  size: number; // dužina snippet-a (proksi za veličinu)
  type: string;
  path: string;
}

interface Region {
  key: string;
  label: string;
  count: number;
  nodes: RegionNode[]; // top-N po skoru, sortirano opadajuće
  all: RegionNode[]; // svi čvorovi regiona (za drill-down)
}

const TOP_N = 14;

/** Sirovi skor atoma: veze najviše nose, pa veličina, pa mala osnova. */
function rawScore(a: ApiAtom): number {
  const conn = a.links?.length ?? 0;
  const size = a.snippet?.length ?? 0;
  return conn * 6 + size / 45 + 1;
}

function buildRegions(atoms: ApiAtom[]): { regions: Region[]; total: number } {
  const byDomain = new Map<string, ApiAtom[]>();
  for (const a of atoms) {
    const key = a.domain || "global";
    const list = byDomain.get(key) ?? [];
    list.push(a);
    byDomain.set(key, list);
  }

  // Poredak regiona: poznati domeni prvo (stabilno), pa ostali po abecedi.
  const ORDER = ["filmium", "codium", "imperium", "kalima", "global"];
  const keys = Array.from(byDomain.keys()).sort((x, y) => {
    const ix = ORDER.indexOf(x);
    const iy = ORDER.indexOf(y);
    if (ix !== -1 && iy !== -1) return ix - iy;
    if (ix !== -1) return -1;
    if (iy !== -1) return 1;
    return x.localeCompare(y);
  });

  const regions: Region[] = keys.map((key) => {
    const list = byDomain.get(key) ?? [];
    const raws = list.map(rawScore);
    const max = Math.max(1, ...raws);
    const all: RegionNode[] = list.map((a, i) => ({
      id: a.id,
      label: a.title || a.id,
      score: Math.min(1, raws[i] / max),
      conn: a.links?.length ?? 0,
      size: a.snippet?.length ?? 0,
      type: a.type || "note",
      path: a.id,
    }));
    all.sort((p, q) => q.score - p.score);
    return {
      key,
      label: key.toUpperCase(),
      count: all.length,
      nodes: all.slice(0, TOP_N),
      all,
    };
  });

  return { regions, total: atoms.length };
}

async function fetchAtoms(signal?: AbortSignal): Promise<ApiAtom[]> {
  try {
    const res = await fetch("/api/atoms?full=1", { signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { atoms?: ApiAtom[] };
    return Array.isArray(body.atoms) ? body.atoms : [];
  } catch {
    return [];
  }
}

type Drill = { key: string; label: string; nodes: RegionNode[] } | null;

interface Props {
  onInspect?: (atom: OrbitalInspectTarget) => void;
}

export default function RegionsView({ onInspect }: Props) {
  const [atoms, setAtoms] = useState<ApiAtom[]>([]);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<Drill>(null);
  const [hover, setHover] = useState<RegionNode | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    fetchAtoms(ctrl.signal)
      .then((a) => {
        if (alive) setAtoms(a);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, []);

  const { regions, total } = useMemo(() => buildRegions(atoms), [atoms]);

  const GAP = 5;
  const n = regions.length;
  const span = n > 0 ? (360 - GAP * n) / n : 360;
  const drillIdx = drill ? regions.findIndex((r) => r.key === drill.key) : -1;
  const drillColor = drill ? colorFor(drill.key, drillIdx < 0 ? 0 : drillIdx) : "#4f9df0";

  return (
    <div className="brain-regions">
      {loading && <p className="brain-message">Učitavam regione…</p>}
      {!loading && n === 0 && <p className="brain-message">Nema atoma za prikaz.</p>}

      <svg className="brain-regions-svg" viewBox="0 0 1000 1000">
        {/* Jezgro sistema */}
        <circle className="brain-region-core" cx={CX} cy={CY} r={CORE_R} />
        <text className="brain-region-core-label" x={CX} y={CY - 3}>
          AI OS
        </text>
        <text className="brain-region-core-sub" x={CX} y={CY + 15}>
          {total} atoma
        </text>

        {/* PREGLED: isečeni prstenovi + top-N tačke */}
        {!drill
          && regions.map((r, i) => {
            const a0 = i * (span + GAP) + GAP / 2;
            const a1 = a0 + span;
            const mid = (a0 + a1) / 2;
            const col = colorFor(r.key, i);
            const [lx, ly] = polar(148, mid);
            return (
              <g
                className="brain-region-seg"
                key={r.key}
                onClick={() => setDrill({ key: r.key, label: r.label, nodes: r.all })}
              >
                <path
                  d={segPath(104, 172, a0, a1)}
                  fill={col}
                  opacity={0.2}
                  stroke={col}
                  strokeWidth={1.5}
                />
                <text className="brain-region-label" fill={col} x={lx} y={ly}>
                  {r.label}
                </text>
                <text className="brain-region-count" x={lx} y={ly + 19}>
                  {r.count}
                </text>
                {r.nodes.map((node, j) => {
                  const t = r.nodes.length > 1 ? j / (r.nodes.length - 1) : 0.5;
                  const na = a0 + 10 + t * (span - 20);
                  const nr = 235 + (1 - node.score) * 155;
                  const [nx, ny] = polar(nr, na);
                  return (
                    <circle
                      className="brain-region-node"
                      cx={nx}
                      cy={ny}
                      fill={col}
                      key={node.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDrill({ key: r.key, label: r.label, nodes: r.all });
                      }}
                      onMouseEnter={() => setHover(node)}
                      onMouseLeave={() => setHover(null)}
                      r={4 + node.score * 6}
                    />
                  );
                })}
              </g>
            );
          })}

        {/* DRILL-DOWN: svi čvorovi regiona u koncentričnim pod-prstenovima */}
        {drill
          && drill.nodes.map((node, j) => {
            const per = Math.max(24, Math.ceil(drill.nodes.length / 8));
            const ringIdx = Math.floor(j / per);
            const inRing = j % per;
            const a = (inRing / per) * 360 + ringIdx * 9;
            const nr = 150 + ringIdx * 42;
            const [nx, ny] = polar(nr, a);
            return (
              <circle
                className="brain-region-node drill"
                cx={nx}
                cy={ny}
                fill={drillColor}
                key={node.id}
                onClick={() => onInspect?.({ path: node.path, label: node.label })}
                onMouseEnter={() => setHover(node)}
                onMouseLeave={() => setHover(null)}
                r={3 + node.score * 5}
              />
            );
          })}
      </svg>

      {drill && (
        <div className="brain-region-drillbar">
          <button
            className="brain-region-back"
            onClick={() => setDrill(null)}
            type="button"
          >
            ← Regioni
          </button>
          <span className="brain-region-drilltitle" style={{ color: drillColor }}>
            {drill.label} · {drill.nodes.length} atoma
          </span>
        </div>
      )}

      {hover && (
        <div className="brain-region-tip">
          <strong>{hover.label}</strong>
          <span>
            skor {hover.score.toFixed(2)} · {hover.conn} veza · {hover.type}
          </span>
        </div>
      )}
    </div>
  );
}
