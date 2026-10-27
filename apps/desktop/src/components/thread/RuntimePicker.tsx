import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadAcpAgents } from "@/lib/acpAgents";
import { detectCliAgentsOnce, ensureCliAgent, type CliAgent } from "@/lib/cliAgents";
import { cn } from "@/lib/cn";

/** The value the select uses for the bundled runtime (an option needs a string). */
const OPENCODE = "";

/**
 * Which agent a conversation runs on: the bundled OpenCode runtime, or an ACP
 * agent (Claude Code, Codex, any configured command).
 *
 * A draft chooses; a conversation keeps what it started on, so the control is
 * shown locked there — it says which agent is answering. Agents found on PATH
 * but never used get their entry on first pick (`ensureCliAgent`).
 */
export function RuntimePicker({
  value,
  onChange,
  locked,
}: {
  value: string | null;
  onChange: (agentId: string | null) => void;
  locked: boolean;
}) {
  const { t } = useTranslation("session");
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
  const choices = [
    ...configured.map((a) => ({ id: a.id, name: a.name })),
    ...detected.filter((d) => !configured.some((a) => a.id === d.id)).map((d) => ({ id: d.id, name: d.name })),
  ];
  // A conversation on an agent since removed from Settings still names it.
  if (value && !choices.some((c) => c.id === value)) choices.push({ id: value, name: value });
  if (choices.length === 0) return null;

  const pick = (id: string) => {
    if (!id) return onChange(null);
    const cli = detected.find((d) => d.id === id);
    if (cli && !configured.some((a) => a.id === id)) ensureCliAgent(cli);
    onChange(id);
  };

  return (
    <select
      className={cn(
        "h-7 max-w-[9rem] shrink-0 rounded-input border border-transparent bg-transparent pl-2 text-[12px]",
        "text-muted outline-none transition-colors select-chrome",
        "hover:bg-surface-2 hover:text-text focus:border-accent/45 focus:bg-surface-2",
        "disabled:hover:bg-transparent disabled:hover:text-muted",
      )}
      aria-label={t("composer.runtime.aria")}
      title={locked ? t("composer.runtime.locked") : t("composer.runtime.title")}
      disabled={locked}
      value={value ?? OPENCODE}
      onChange={(e) => pick(e.target.value)}
    >
      {/* eslint-disable-next-line i18next/no-literal-string -- product name, shown as-is */}
      <option value={OPENCODE}>OpenCode</option>
      {choices.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
