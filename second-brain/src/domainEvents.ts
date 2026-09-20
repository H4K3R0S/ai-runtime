// ========== domainEvents — jedan deljeni SSE tok događaja domena ==========
// KORAK 4: „Tauri listen('domain-event', …)" je ovde Server-Sent Events tok sa
// backend-a (`/api/events`). Jedna deljena EventSource veza; komponente se
// pretplate i dobiju funkciju za ODJAVU (unlisten) — bez curenja slušalaca.
//
// Oblik događaja (šalje ga pozadina: router-api / domeni / alati):
//   { domain: "kalima", type: "memory", label: "cve_found.md",
//     parent?: "meta-10-10-10-5", path?: "kalima/nauceno/cve.md", append?: "…" }

export interface DomainEvent {
  domain: string;
  type: string; // memory | routine | app | skill | …
  label: string;
  parent?: string;
  path?: string; // token atoma (rootKey/rel) — za reaktivni sidebar
  append?: string; // dopisani tekst (streaming efekat u sidebar-u)
  ts?: number;
}

type Handler = (event: DomainEvent) => void;

const handlers = new Set<Handler>();
let source: EventSource | null = null;

function ensureSource(): void {
  if (source || typeof EventSource === "undefined") return;
  try {
    source = new EventSource("/api/events");
    source.onmessage = (msg) => {
      let event: DomainEvent | null = null;
      try {
        event = JSON.parse(msg.data) as DomainEvent;
      } catch {
        return;
      }
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          /* jedan loš handler ne ruši ostale */
        }
      }
    };
    // EventSource se sam ponovo povezuje na grešci; ništa dodatno ne radimo.
    source.onerror = () => {};
  } catch {
    source = null;
  }
}

/** Pretplati se na događaje domena; vrati funkciju za odjavu (unlisten). */
export function subscribeDomainEvents(handler: Handler): () => void {
  handlers.add(handler);
  ensureSource();
  return () => {
    handlers.delete(handler);
  };
}
