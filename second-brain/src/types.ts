// ========== ARMS model podataka za orbitalni Second Brain ==========
// Četiri orbite (ARMS): Applications / Routines / Memory / Skills.

export type OrbitKey = "applications" | "routines" | "memory" | "skills";

export interface OrbitalNode {
  id: string;
  label: string;
  orbit: OrbitKey;
  /** Domen kome čvor pripada (npr. "kalima") — za kasnije bojenje/relacije. */
  group?: string;
  /** Slobodni meta podaci (kapabilnosti, putanje…), koristi ih kasniji korak. */
  meta?: Record<string, unknown>;
}

export interface OrbitalData {
  applications: OrbitalNode[];
  routines: OrbitalNode[];
  memory: OrbitalNode[];
  skills: OrbitalNode[];
}

/** Sirovi oblik router manifesta (system_routing_manifest.json). */
export interface RoutingManifest {
  version?: string;
  router?: { host?: string; port?: number; maxHops?: number };
  domains?: Record<string, { host?: string; port?: number; capabilities?: string[] }>;
}
