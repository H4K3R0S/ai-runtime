// ========== FileInspectorSidebar — klizni panel za pregled atoma ==========
// KORAK 3: klizni panel (translateX 100%->0, 0.3s); klik Memory čvora -> čita
//   atom preko /api/atom (Electron/HTTP zamena za Tauri invoke/Rust).
// KORAK 4: REAKTIVNO UŽIVO — dok je panel otvoren za neki atom, a pozadina
//   (agent) dopisuje u njega (SSE event sa istim `path`), sadržaj se ažurira bez
//   ponovnog klika: `append` tekst se ispisuje streaming efektom, inače re-fetch.
//   Intervali i pretplata se čiste na unmount / promenu atoma (bez leak-a).

import { useEffect, useRef, useState, type ReactNode } from "react";

import { subscribeDomainEvents } from "./domainEvents";
import type { OrbitalInspectTarget } from "./OrbitalSecondBrain";

interface Props {
  atom: OrbitalInspectTarget | null;
  onClose: () => void;
}

interface AtomResponse {
  path: string;
  exists: boolean;
  content?: string;
  error?: string;
}

type LoadStatus = "idle" | "loading" | "ok" | "error";

function parseAtom(text: string): { frontmatter: Array<[string, string]>; body: string } {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const fm: Array<[string, string]> = [];
      for (const line of text.slice(3, end).split("\n")) {
        const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
        if (m) fm.push([m[1], m[2]]);
      }
      const nl = text.indexOf("\n", end + 1);
      const body = nl !== -1 ? text.slice(nl + 1) : "";
      return { frontmatter: fm, body: body.replace(/^\n+/, "") };
    }
  }
  return { frontmatter: [], body: text };
}

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span className="wikilink" key={`w${key}`}>
        {m[1]}
      </span>,
    );
    key += 1;
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

export default function FileInspectorSidebar({ atom, onClose }: Props) {
  const open = atom !== null;
  const [display, setDisplay] = useState<OrbitalInspectTarget | null>(null);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState("");
  const [live, setLive] = useState(false); // blicne kad stigne uživo dopuna

  const displayRef = useRef<OrbitalInspectTarget | null>(null);
  displayRef.current = display;
  const contentRef = useRef("");
  contentRef.current = content;
  const streamRef = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const clearStream = () => {
    if (streamRef.current !== null) {
      window.clearInterval(streamRef.current);
      streamRef.current = null;
    }
  };

  // Učitavanje atoma na klik (KORAK 3).
  useEffect(() => {
    if (!atom) return;
    clearStream();
    setDisplay(atom);
    setStatus("loading");
    setError("");
    setContent("");
    const ctrl = new AbortController();
    fetch(`/api/atom?path=${encodeURIComponent(atom.path)}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as AtomResponse;
        if (!res.ok || !body.exists) {
          setStatus("error");
          setError(body.error || `HTTP ${res.status}`);
          return;
        }
        setContent(body.content || "");
        setStatus("ok");
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setStatus("error");
        setError(String(e));
      });
    return () => ctrl.abort();
  }, [atom]);

  // Reaktivno uživo (KORAK 4): SSE dopune za trenutno otvoreni atom.
  useEffect(() => {
    const unsub = subscribeDomainEvents((event) => {
      const d = displayRef.current;
      if (!d || !event.path || event.path !== d.path) return;
      setLive(true);
      window.setTimeout(() => setLive(false), 1200);
      if (typeof event.append === "string" && event.append.length > 0) {
        // Streaming ispis dopisanog teksta.
        clearStream();
        const base = contentRef.current.endsWith("\n") ? contentRef.current : `${contentRef.current}\n`;
        const tail = event.append;
        let i = 0;
        streamRef.current = window.setInterval(() => {
          i = Math.min(tail.length, i + 3);
          setContent(base + tail.slice(0, i));
          if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
          if (i >= tail.length) clearStream();
        }, 25);
      } else {
        // Sadržaj promenjen na disku -> ponovo učitaj.
        fetch(`/api/atom?path=${encodeURIComponent(d.path)}`)
          .then(async (res) => {
            const body = (await res.json().catch(() => ({}))) as AtomResponse;
            if (res.ok && body.exists) setContent(body.content || "");
          })
          .catch(() => {});
      }
    });
    return () => {
      unsub();
      clearStream();
    };
  }, []);

  const parsed = parseAtom(content);

  return (
    <aside className={`inspector ${open ? "inspector--open" : ""}`} aria-hidden={!open}>
      <header className="inspector__head">
        <div className="inspector__titles">
          <span className="inspector__title">
            {display?.label ?? "Atom"}
            {live && <span className="inspector__live">uživo</span>}
          </span>
          {display && <span className="inspector__path">{display.path}</span>}
        </div>
        <button className="inspector__close" onClick={onClose} aria-label="Zatvori" type="button">
          ×
        </button>
      </header>
      <div className="inspector__body" ref={bodyRef}>
        {status === "loading" && <div className="inspector__note">Učitavam atom…</div>}
        {status === "error" && <div className="inspector__error">Greška: {error}</div>}
        {status === "ok" && (
          <>
            {parsed.frontmatter.length > 0 && (
              <dl className="inspector__meta">
                {parsed.frontmatter.map(([k, v]) => (
                  <div className="inspector__meta-row" key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="inspector__content">{renderInline(parsed.body)}</div>
          </>
        )}
      </div>
    </aside>
  );
}
