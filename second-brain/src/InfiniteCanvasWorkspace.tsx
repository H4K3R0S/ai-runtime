// ========== InfiniteCanvasWorkspace — beskonačno platno (KORACI 5–7) ==========
// K5: React Flow platno, rich kartice (mini-čet /api/ask), bezier veze.
// K6: MediaPreviewCard (slike/PDF/video) + maksimizacija u MediaViewerSidebar.
// K7: (a) izbor METE u toolbar-u -> centriraj i „učitaj" graf te mete (filter+fitView);
//     (b) LIVE loot spawning preko SSE — nova kartica (tekst/slika) se rađa i
//         linijom spaja sa hub čvorom, bez refresh-a; cap + unlisten (bez leak-a);
//     (c) Collapse/Expand All — sakrij/prikaži sve media preview kartice.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { subscribeDomainEvents } from "./domainEvents";
import type { MediaTarget } from "./MediaViewerSidebar";

interface ApiAtom { id: string; title: string; type: string; domain: string; snippet: string; links: string[]; }
interface ApiMedia { id: string; path: string; kind: "image" | "pdf" | "video"; name: string; domain: string; }
interface AtomData extends Record<string, unknown> { title: string; type: string; domain: string; snippet: string; path: string; }
interface MediaData extends Record<string, unknown> { path: string; kind: "image" | "pdf" | "video"; name: string; domain: string; }

const MaximizeContext = createContext<(m: MediaTarget) => void>(() => {});

const TYPE_ICON: Record<string, string> = {
  persona: "🧠", tool: "🔧", command: "⌘", note: "📝", code: "💻",
  meta: "🎯", ip: "🌐", film: "🎬", log: "📜", loot: "💰",
};
const iconFor = (t: string) => TYPE_ICON[t] ?? "📄";
const KIND_ICON: Record<string, string> = { image: "🖼️", pdf: "📕", video: "🎞️" };

const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;
const mediaSrc = (p: string) => `/api/media?path=${encodeURIComponent(p)}`;

function slugify(text: string): string {
  return (
    text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "atom"
  );
}

// ---- Rich atom kartica ----
function AtomCardNode({ data }: NodeProps) {
  const d = data as AtomData;
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setAnswer(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: d.path, question: q }),
      });
      const body = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
      setAnswer(res.ok ? body.answer || "(prazan odgovor)" : body.error || `HTTP ${res.status}`);
    } catch (e) {
      setAnswer(String(e));
    } finally {
      setBusy(false);
    }
  }, [question, busy, d.path]);

  return (
    <div className="atomcard">
      <Handle type="target" position={Position.Left} />
      <div className="atomcard__head">
        <span className="atomcard__icon">{iconFor(d.type)}</span>
        <span className="atomcard__title">{d.title}</span>
      </div>
      <div className="atomcard__meta">{d.type} · {d.domain}</div>
      <div className="atomcard__snippet">{d.snippet || "(prazan sadržaj)"}</div>
      {d.path && (
        <div className="atomcard__chat nodrag">
          <input
            className="atomcard__input nodrag nopan nowheel"
            value={question}
            placeholder="Ask a question…"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") ask();
            }}
          />
          <button className="atomcard__ask" onClick={ask} disabled={busy} type="button">
            {busy ? "…" : "→"}
          </button>
        </div>
      )}
      {(answer !== null || busy) && (
        <div className="atomcard__answer">{busy ? "razmišljam…" : answer}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// ---- MediaPreviewCard ----
function MediaPreviewNode({ data }: NodeProps) {
  const d = data as MediaData;
  const maximize = useContext(MaximizeContext);
  const [failed, setFailed] = useState(false);
  const src = mediaSrc(d.path);
  const open = () => maximize({ path: d.path, kind: d.kind, name: d.name });

  return (
    <div className="mediacard">
      <Handle type="target" position={Position.Left} />
      <div className="mediacard__head">
        <span>{KIND_ICON[d.kind] ?? "📎"}</span>
        <span className="mediacard__name" title={d.name}>{d.name}</span>
      </div>
      <button className="mediacard__thumb nodrag" onClick={open} type="button" title="Uvećaj">
        {failed ? (
          <span className="mediacard__fallback">{KIND_ICON[d.kind]} {d.kind}</span>
        ) : d.kind === "image" ? (
          <img src={src} alt={d.name} loading="lazy" onError={() => setFailed(true)} />
        ) : d.kind === "pdf" ? (
          <embed src={`${src}#toolbar=0&navpanes=0`} type="application/pdf" />
        ) : (
          <video src={src} muted preload="metadata" onError={() => setFailed(true)} />
        )}
        <span className="mediacard__overlay">uvećaj ⤢</span>
      </button>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const COL_W = 340;
const ROW_H = 210;
const MAX_LIVE = 24; // gornja granica živorođenih čvorova (zaštita od preopterećenja)

interface DomainMeta { colX: number; nextRow: number; }

interface Props {
  onMaximizeMedia: (m: MediaTarget) => void;
}

export default function InfiniteCanvasWorkspace({ onMaximizeMedia }: Props) {
  const nodeTypes = useMemo(() => ({ atomCard: AtomCardNode, mediaPreview: MediaPreviewNode }), []);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [target, setTarget] = useState<string>("all");
  const [showMedia, setShowMedia] = useState(true);

  const rfRef = useRef<ReactFlowInstance | null>(null);
  const hubByDomainRef = useRef<Map<string, string>>(new Map());
  const domainMetaRef = useRef<Map<string, DomainMeta>>(new Map());
  const liveIdsRef = useRef<string[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      fetch("/api/atoms", { signal: ctrl.signal }).then((r) => r.json()),
      fetch("/api/media-list", { signal: ctrl.signal }).then((r) => r.json()).catch(() => ({ media: [] })),
    ])
      .then(([atomsBody, mediaBody]: [{ atoms?: ApiAtom[] }, { media?: ApiMedia[] }]) => {
        const atoms = atomsBody.atoms ?? [];
        const media = mediaBody.media ?? [];
        if (atoms.length === 0) {
          setError("Nema atoma (backend /api/atoms prazan).");
          return;
        }
        const byDomain = new Map<string, ApiAtom[]>();
        for (const a of atoms) {
          const list = byDomain.get(a.domain) ?? [];
          list.push(a);
          byDomain.set(a.domain, list);
        }
        const doms = [...byDomain.keys()].sort();

        const nextNodes: Node[] = [];
        const hubs = new Map<string, string>();
        const meta = new Map<string, DomainMeta>();
        doms.forEach((dom, ci) => {
          const list = byDomain.get(dom)!;
          hubs.set(dom, list[0].id);
          meta.set(dom, { colX: ci * COL_W, nextRow: list.length + 1 });
          list.forEach((a, ri) => {
            nextNodes.push({
              id: a.id, type: "atomCard", position: { x: ci * COL_W, y: ri * ROW_H },
              data: { title: a.title, type: a.type, domain: a.domain, snippet: a.snippet, path: a.id },
            });
          });
        });

        const bySlug = new Map<string, string>();
        for (const a of atoms) {
          const seg = a.id.split("/").pop()!.replace(/\.md$/, "");
          bySlug.set(seg, a.id);
          bySlug.set(slugify(seg), a.id);
          bySlug.set(slugify(a.title), a.id);
        }
        const nextEdges: Edge[] = [];
        const seen = new Set<string>();
        for (const a of atoms) {
          for (const t of a.links ?? []) {
            const tid = bySlug.get(t) ?? bySlug.get(slugify(t));
            if (tid && tid !== a.id && !seen.has(`${a.id}|${tid}`)) {
              seen.add(`${a.id}|${tid}`);
              nextEdges.push({ id: `l:${a.id}->${tid}`, source: a.id, target: tid, animated: true });
            }
          }
        }
        for (const dom of doms) {
          const list = byDomain.get(dom)!;
          const hub = list[0].id;
          for (let i = 1; i < list.length; i += 1) {
            nextEdges.push({ id: `s:${dom}:${i}`, source: hub, target: list[i].id, style: { stroke: "#33456a", strokeDasharray: "4 4" } });
          }
        }

        const laneX = doms.length * COL_W + 80;
        media.forEach((m, i) => {
          const nodeId = `media:${m.id}`;
          nextNodes.push({
            id: nodeId, type: "mediaPreview", position: { x: laneX, y: i * 180 },
            data: { path: m.path, kind: m.kind, name: m.name, domain: m.domain },
          });
          const hub = hubs.get(m.domain);
          if (hub) nextEdges.push({ id: `m:${hub}->${nodeId}`, source: hub, target: nodeId, style: { stroke: "#6a5acd", strokeWidth: 1 } });
        });

        hubByDomainRef.current = hubs;
        domainMetaRef.current = meta;
        setDomains(doms);
        setNodes(nextNodes);
        setEdges(nextEdges);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setError(String(e));
      });
    return () => ctrl.abort();
  }, []);

  // K7b: LIVE loot spawning preko SSE (unlisten na unmount, cap FIFO).
  useEffect(() => {
    const unsub = subscribeDomainEvents((ev) => {
      const dom = ev.domain;
      const meta = domainMetaRef.current.get(dom);
      const hub = hubByDomainRef.current.get(dom);
      const pos = meta ? { x: meta.colX, y: meta.nextRow * ROW_H } : { x: 0, y: 0 };
      if (meta) meta.nextRow += 1;
      const ts = ev.ts ?? Date.now();
      const isImg = ev.type === "image" || (!!ev.path && IMG_RE.test(ev.path)) || IMG_RE.test(ev.label);
      const id = `live:${dom}:${ev.label}:${ts}`;
      const node: Node =
        isImg && ev.path
          ? { id, type: "mediaPreview", position: pos, className: "spawn-in", data: { path: ev.path, kind: "image", name: ev.label, domain: dom } }
          : { id, type: "atomCard", position: pos, className: "spawn-in", data: { title: ev.label, type: ev.type || "loot", domain: dom, snippet: "(uživo iz pozadine)", path: ev.path || "" } };

      // FIFO cap: izbaci najstariji živorođeni + njegove ivice.
      liveIdsRef.current.push(id);
      let removeId: string | null = null;
      if (liveIdsRef.current.length > MAX_LIVE) removeId = liveIdsRef.current.shift() ?? null;

      setNodes((prev) => {
        const base = removeId ? prev.filter((n) => n.id !== removeId) : prev;
        return [...base, node];
      });
      setEdges((prev) => {
        const base = removeId ? prev.filter((e) => e.source !== removeId && e.target !== removeId) : prev;
        if (!hub) return base;
        return [...base, { id: `live-e:${id}`, source: hub, target: id, animated: true, style: { stroke: "#7ee0a0" } }];
      });
    });
    return unsub;
  }, []);

  // K7a: filter po meti + Collapse media (preko `hidden`, pozicije se čuvaju).
  const displayNodes = useMemo<Node[]>(
    () =>
      nodes.map((n): Node => {
        const dom = (n.data as { domain?: string }).domain;
        const isMedia = n.type === "mediaPreview";
        const hidden = (target !== "all" && dom !== target) || (!showMedia && isMedia);
        return { ...n, hidden };
      }),
    [nodes, target, showMedia],
  );
  const displayEdges = useMemo<Edge[]>(() => {
    const visible = new Set(displayNodes.filter((n) => !n.hidden).map((n) => n.id));
    return edges.map((e): Edge => ({ ...e, hidden: !visible.has(e.source) || !visible.has(e.target) }));
  }, [edges, displayNodes]);

  // K7a: centriraj/„učitaj" graf izabrane mete.
  useEffect(() => {
    const inst = rfRef.current;
    if (!inst || nodes.length === 0) return;
    const focus =
      target === "all"
        ? undefined
        : nodes.filter((n) => (n.data as { domain?: string }).domain === target).map((n) => ({ id: n.id }));
    const id = requestAnimationFrame(() =>
      inst.fitView(focus && focus.length ? { nodes: focus, duration: 600, padding: 0.25 } : { duration: 600, padding: 0.12 }),
    );
    return () => cancelAnimationFrame(id);
  }, [target, nodes]);

  return (
    <div className="canvas-wrap">
      {error && <div className="canvas-error">{error}</div>}
      <div className="canvas-toolbar">
        <label className="canvas-toolbar__label">Meta:</label>
        <select
          className="canvas-toolbar__select"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="all">Sve</option>
          {domains.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button className="canvas-toolbar__btn" onClick={() => setShowMedia(false)} type="button" disabled={!showMedia}>
          Collapse All
        </button>
        <button className="canvas-toolbar__btn" onClick={() => setShowMedia(true)} type="button" disabled={showMedia}>
          Expand All
        </button>
      </div>
      <MaximizeContext.Provider value={onMaximizeMedia}>
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onInit={(inst) => {
            rfRef.current = inst;
          }}
          fitView
          minZoom={0.12}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={26} color="#22304d" />
          <MiniMap pannable zoomable nodeColor="#4f9df0" maskColor="rgba(5,9,20,0.7)" />
          <Controls />
        </ReactFlow>
      </MaximizeContext.Provider>
    </div>
  );
}
