// The agents a conversation can run on, as the composer offers them: the
// bundled OpenCode runtime, every configured ACP agent, and the coding agents
// found on this machine that were never configured (their entry is made on
// first pick).
import { useEffect, useState } from "react";
import { loadAcpAgents } from "./acpAgents";
import { detectCliAgentsOnce, ensureCliAgent, type CliAgent } from "./cliAgents";

export interface AgentChoice {
  /** ACP agent id, or null for OpenCode. */
  id: string | null;
  name: string;
}

export const OPENCODE_NAME = "OpenCode";

export function useAgentChoices(current: string | null): {
  choices: AgentChoice[];
  /** Resolve a pick: an agent found on PATH gets its configured entry first. */
  pick: (id: string | null) => string | null;
} {
  const [detected, setDetected] = useState<CliAgent[]>([]);
  useEffect(() => {
    let cancelled = false;
    void detectCliAgentsOnce().then((found) => {
      if (!cancelled) setDetected(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const configured = loadAcpAgents();
  const choices: AgentChoice[] = [
    { id: null, name: OPENCODE_NAME },
    ...configured.map((a) => ({ id: a.id, name: a.name })),
    ...detected.filter((d) => !configured.some((a) => a.id === d.id)).map((d) => ({ id: d.id, name: d.name })),
  ];
  // A conversation on an agent since removed from Settings still names it.
  if (current && !choices.some((c) => c.id === current)) choices.push({ id: current, name: current });

  const pick = (id: string | null) => {
    const cli = id ? detected.find((d) => d.id === id) : undefined;
    if (cli && !configured.some((a) => a.id === id)) ensureCliAgent(cli);
    return id;
  };
  return { choices, pick };
}
