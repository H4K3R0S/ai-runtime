// ========== IZVOR PODATAKA: system_routing_manifest.json + lokalni RAG ==========
// Čvorovi orbita se izvode iz centralnog router manifesta (Applications = domeni,
// Skills = kapabilnosti agenata) i lokalnih RAG baza po domenu (Memory), plus
// realne OS pozadinske rutine (Routines). Sve je TOLERANTNO: ako manifest nije
// dostupan, vraćamo razuman fallback da render nikad ne ostane prazan.
//
// (Kasniji koraci — 3/4 — dovlače prave atomske fajlove i događaje uživo.)

import type { OrbitalData, OrbitalNode, RoutingManifest } from "./types";

const MANIFEST_URL = "/system_routing_manifest.json";

// OS pozadinske rutine koje stварno rade kao servisi na ovom sistemu.
const OS_ROUTINES = ["ai-router", "searxng", "ollama"] as const;

function fromManifest(manifest: RoutingManifest): OrbitalData {
  const domains = manifest.domains ?? {};
  const domainNames = Object.keys(domains).sort();

  const applications: OrbitalNode[] = domainNames.map((name) => ({
    id: `app:${name}`,
    label: name.toUpperCase(),
    orbit: "applications",
    group: name,
    meta: { port: domains[name]?.port },
  }));

  // Svaka kapabilnost pripada domenu koji je nudi (prvi po abecedi ako se
  // ponavlja) — tako Skill čvor ima `group` i može da se poveže relacijama.
  const capOwner = new Map<string, string>();
  for (const name of domainNames) {
    for (const cap of domains[name]?.capabilities ?? []) {
      if (!capOwner.has(cap)) capOwner.set(cap, name);
    }
  }
  const skills: OrbitalNode[] = Array.from(capOwner.entries()).map(([cap, owner]) => ({
    id: `skill:${cap}`,
    label: cap,
    orbit: "skills",
    group: owner,
  }));

  const memory: OrbitalNode[] = domainNames.map((name) => ({
    id: `mem:${name}`,
    label: `${name} RAG`,
    orbit: "memory",
    group: name,
  }));

  // Rutine: realni OS servisi + po jedan agent-loop po domenu (fallthrough/RAG).
  const routines: OrbitalNode[] = [
    ...OS_ROUTINES.map((svc) => ({ id: `routine:${svc}`, label: svc, orbit: "routines" as const })),
    ...domainNames.map((name) => ({
      id: `routine:${name}-agent`,
      label: `${name}-agent`,
      orbit: "routines" as const,
      group: name,
    })),
  ];

  return { applications, routines, memory, skills };
}

function fallback(): OrbitalData {
  return fromManifest({
    domains: {
      codium: { capabilities: ["code", "dev", "exploit", "ctf", "build", "debug"] },
      filmium: { capabilities: ["film", "video", "media", "youtube-script", "subtitle"] },
      imperium: { capabilities: ["orchestration", "strategy", "planning", "osint"] },
      kalima: { capabilities: ["pentest", "recon", "target", "ip", "scan", "meta"] },
    },
  });
}

interface ApiAtom {
  id: string;
  title: string;
  domain: string;
  type: string;
}

/** Memory orbita iz pravih atoma (backend `/api/atoms`); [] ako backend nije tu. */
async function loadMemoryAtoms(signal?: AbortSignal): Promise<OrbitalNode[]> {
  try {
    const res = await fetch("/api/atoms", { signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { atoms?: ApiAtom[] };
    return (body.atoms ?? []).map((a) => ({
      id: `mem:${a.id}`,
      label: a.title,
      orbit: "memory" as const,
      group: a.domain === "global" ? undefined : a.domain,
      meta: { path: a.id, type: a.type },
    }));
  } catch {
    return [];
  }
}

export async function loadOrbitalData(signal?: AbortSignal): Promise<OrbitalData> {
  let data: OrbitalData;
  try {
    const res = await fetch(MANIFEST_URL, { signal });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const manifest = (await res.json()) as RoutingManifest;
    data = fromManifest(manifest);
    if (data.applications.length === 0) data = fallback();
  } catch {
    data = fallback();
  }
  // Memory: zameni po-domen placeholdere pravim atomskim fajlovima ako ih ima.
  const atoms = await loadMemoryAtoms(signal);
  if (atoms.length > 0) data = { ...data, memory: atoms };
  return data;
}
