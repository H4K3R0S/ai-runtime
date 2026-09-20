// ========== ApprovalCard — vizuelni gate osigurač (F7b) ==========
// Kad F5 executor napravi HIGH/CRITICAL gate, emituje SSE `type:"gate"` na
// /api/events. Ova komponenta sluša isti deljeni EventSource (domainEvents.ts),
// drži red pending gate-ova (dedupe po gate_id) i renderuje stek kartica sa
// dugmadima ODOBRI/ODBIJ. Klik zove server.mjs proxy (/api/approve, /api/reject)
// koji tek prosleđuje ka domenskoj ćeliji — GUI nikad ne pogađa domen direktno
// (bez CORS-a). Na uspeh kartica nestaje iz reda; na grešku ostaje sa porukom.
//
// Ugovor gate event-a (tolerantno na nedostajuća polja):
//   { type:"gate", domain, gate_id, tool, risk, reason, raw_command, token, expires_in_s }

import { useEffect, useRef, useState } from "react";

import { subscribeDomainEvents, type DomainEvent } from "./domainEvents";

// Stvarni gate event ima drugačiji oblik od DomainEvent (nema `label`), zato
// čitamo sirovi event kao GateEvent — bez runtime provere, samo za TS.
interface GateEvent {
  type?: string;
  domain?: string;
  gate_id?: string;
  gateId?: string;
  tool?: string;
  risk?: string;
  reason?: string;
  raw_command?: string;
  command?: string;
  token?: string;
  expires_in_s?: number;
}

interface PendingGate {
  gateId: string;
  domain: string;
  tool: string;
  risk: string;
  reason: string;
  command: string;
  token: string;
  expiresInS?: number;
}

type CardStatus = "idle" | "busy" | "error";

function normalizeGate(evt: GateEvent): PendingGate | null {
  const gateId = evt.gate_id || evt.gateId;
  if (!gateId) return null; // bez ID-a nema šta da se dedupe-uje/odobrava
  return {
    gateId,
    domain: evt.domain || "?",
    tool: evt.tool || "?",
    risk: (evt.risk || "?").toUpperCase(),
    reason: evt.reason || "(bez razloga)",
    command: evt.raw_command || evt.command || "",
    token: evt.token || "",
    expiresInS: evt.expires_in_s,
  };
}

function riskClass(risk: string): string {
  if (risk === "CRITICAL") return "approval-badge--critical";
  if (risk === "HIGH") return "approval-badge--high";
  if (risk === "MEDIUM") return "approval-badge--medium";
  return "approval-badge--low";
}

export default function ApprovalCard() {
  const [queue, setQueue] = useState<PendingGate[]>([]);
  const [statusById, setStatusById] = useState<Record<string, CardStatus>>({});
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsub = subscribeDomainEvents((event: DomainEvent) => {
      const evt = event as unknown as GateEvent;
      if (evt.type !== "gate") return;
      const gate = normalizeGate(evt);
      if (!gate || seenRef.current.has(gate.gateId)) return;
      seenRef.current.add(gate.gateId);
      setQueue((q) => [...q, gate]);
    });
    return unsub;
  }, []);

  const remove = (gateId: string) => {
    seenRef.current.delete(gateId);
    setQueue((q) => q.filter((g) => g.gateId !== gateId));
    setStatusById((s) => {
      const n = { ...s };
      delete n[gateId];
      return n;
    });
    setErrorById((s) => {
      const n = { ...s };
      delete n[gateId];
      return n;
    });
  };

  const decide = async (gate: PendingGate, action: "approve" | "reject") => {
    setStatusById((s) => ({ ...s, [gate.gateId]: "busy" }));
    setErrorById((s) => {
      const n = { ...s };
      delete n[gate.gateId];
      return n;
    });
    try {
      const res = await fetch(`/api/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "approve"
            ? { domain: gate.domain, gate_id: gate.gateId, token: gate.token }
            : { domain: gate.domain, gate_id: gate.gateId },
        ),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      remove(gate.gateId);
    } catch (e) {
      setStatusById((s) => ({ ...s, [gate.gateId]: "error" }));
      setErrorById((s) => ({ ...s, [gate.gateId]: String((e as Error)?.message || e) }));
    }
  };

  if (queue.length === 0) return null;

  return (
    <div className="approval-stack" role="alert" aria-live="assertive">
      {queue.map((gate) => {
        const busy = statusById[gate.gateId] === "busy";
        const err = errorById[gate.gateId];
        return (
          <div className="approval-card" key={gate.gateId}>
            <div className="approval-card__head">
              <span className="approval-card__domain">{gate.domain}</span>
              <span className={`approval-badge ${riskClass(gate.risk)}`}>{gate.risk}</span>
            </div>
            <div className="approval-card__tool">{gate.tool}</div>
            <div className="approval-card__reason">{gate.reason}</div>
            {gate.command && <pre className="approval-card__cmd">{gate.command}</pre>}
            <div className="approval-card__meta">
              gate: {gate.gateId}
              {typeof gate.expiresInS === "number" && ` · ističe za ${gate.expiresInS}s`}
            </div>
            {err && <div className="approval-card__error">Greška: {err}</div>}
            <div className="approval-card__actions">
              <button
                className="approval-btn approval-btn--approve"
                type="button"
                disabled={busy}
                onClick={() => decide(gate, "approve")}
              >
                Odobri
              </button>
              <button
                className="approval-btn approval-btn--reject"
                type="button"
                disabled={busy}
                onClick={() => decide(gate, "reject")}
              >
                Odbij
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
