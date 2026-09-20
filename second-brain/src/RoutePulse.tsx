// ========== RoutePulse — „krvotok" indikator (F7b stretch) ==========
// Mali indikator u zaglavlju: poslednja telemetrija F3 rutera
// (~/.cache/ai-router/route.log, JSONL) preko GET /api/routes. Čisto
// informativno — tiho se sakriva ako ruter/log ne postoji, ne blokira ništa.

import { useEffect, useState } from "react";

interface RouteEntry {
  ts?: string;
  capability?: string;
  from?: string;
  to?: string | null;
  hops?: number;
  cache?: string;
  result?: string;
  latency_ms?: number;
}

export default function RoutePulse() {
  const [latest, setLatest] = useState<RouteEntry | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      fetch("/api/routes")
        .then((r) => r.json())
        .then((body: { routes?: RouteEntry[] }) => {
          if (!alive) return;
          const routes = body.routes || [];
          setCount(routes.length);
          setLatest(routes.length ? routes[routes.length - 1] : null);
        })
        .catch(() => {
          if (alive) setLatest(null);
        });
    };
    poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (!latest) return null;

  return (
    <span className="route-pulse" title={`${count} zapisa u route.log`}>
      <span className="route-pulse__dot" />
      ruter · {latest.to || "?"} · {typeof latest.latency_ms === "number" ? `${latest.latency_ms}ms` : "—"}
    </span>
  );
}
