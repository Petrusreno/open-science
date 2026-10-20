/**
 * Specialists (#144) — subagents the user defines on the Skills page. Stored by
 * the desktop as OpenCode agent files (`osd_core::specialists`); these are the
 * pure rules the editor needs before anything is sent there.
 */

/** Mirrors `osd_core::specialists::Specialist` (camelCase over IPC). */
export interface Specialist {
  /** Agent name: what the main agent delegates to and models are pinned by. */
  id: string;
  /** When to use it — the main agent reads this to decide when to delegate. */
  description: string;
  /** `#rrggbb`, or null for the default ink. */
  color: string | null;
  /** Replaces the default system prompt; empty keeps it. */
  instructions: string;
  /** null: every skill. A list: only these. */
  skills: string[] | null;
  /** Connector tool-name prefixes it may not use (see `connectorPrefix`). */
  blockedConnectors: string[];
  /** `provider/model` it runs on; "" follows the default model. */
  model: string;
}

export const MAX_ID = 48;
export const MAX_DESCRIPTION = 1000;
export const MAX_INSTRUCTIONS = 50000;

/** The runtime's own agents; a specialist cannot take one of their names. */
export const NATIVE_AGENTS = ["build", "plan", "general", "explore", "title", "summary", "compaction"];

/** Mid-tone hues that read on both themes, as text and as a 14% tint. Hex,
 *  because that is what the runtime's agent `color` accepts. */
export const SPECIALIST_COLORS = [
  { key: "gray", hex: "#6B7280" },
  { key: "red", hex: "#DC2626" },
  { key: "orange", hex: "#EA580C" },
  { key: "yellow", hex: "#CA8A04" },
  { key: "green", hex: "#16A34A" },
  { key: "aqua", hex: "#0D9488" },
  { key: "blue", hex: "#2563EB" },
  { key: "violet", hex: "#7C3AED" },
  { key: "magenta", hex: "#DB2777" },
] as const;

/** A typed name → the id it is saved under: `Stats reviewer` → `stats-reviewer`,
 *  `论文写作` → `论文写作`. Letters and digits of any script stay (the runtime
 *  takes them as agent names), lower-cased; accents on Latin letters fold
 *  (`Méthodes` → `methodes`); every other run of characters becomes one hyphen.
 *  Same rule as `valid_id` on the Rust side (`is_alphanumeric`, not uppercase).
 *  A name with no letters or digits at all yields "". */
export function specialistId(name: string): string {
  const id = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/[^\p{Alphabetic}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(id).slice(0, MAX_ID).join("").replace(/-+$/, "");
}

/** The prefix the runtime gives a connector's tools (`<server>_<tool>`, with
 *  everything outside `[A-Za-z0-9_-]` replaced by `_`) — same rule as the Rust
 *  side and OpenCode's `mcp/catalog.ts`. */
export function connectorPrefix(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Connectors that blocking `blocked` would take down with it. Blocking is a
 * `<prefix>_*` rule, so blocking `pubmed` also matches every tool of a
 * connector called `pubmed_central`. Returns `[blocked, collateral]` pairs for
 * the editor to refuse rather than save a rule that does more than it says.
 */
export function connectorCollisions(blocked: string[], allowed: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const b of blocked) {
    for (const a of allowed) {
      if (a !== b && a.startsWith(`${b}_`)) out.push([b, a]);
    }
  }
  return out;
}

/** Initial for the avatar tile: the id's first character, upper-cased. */
export function specialistInitial(id: string): string {
  return (Array.from(id.trim())[0] ?? "?").toUpperCase();
}
