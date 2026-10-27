import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/tauri";
import { stopAcpAgent, useRuntimeStore } from "@/lib/runtime";
import {
  ACP_PRESETS,
  formatCommandArgs,
  loadAcpAgents,
  newAcpAgentId,
  parseCommandArgs,
  saveAcpAgents,
  type AcpAgentConfig,
} from "@/lib/acpAgents";
import { inputCls } from "./inputCls";
import { Section } from "./Section";

/**
 * Settings → Runtime → the agents conversations can run on (#14), and which one
 * a new conversation starts on.
 *
 * The bundled OpenCode runtime, or any agent that speaks the Agent Client
 * Protocol over stdio — Codex, Gemini CLI, Claude Code, anything else with an
 * ACP server. Each conversation keeps the agent it started on; the composer
 * picks per conversation, this card sets the default. Adding one is configuring a COMMAND, which is why there is no
 * per-agent code here (docs/rfc/multi-agent-acp.md).
 *
 * Desktop only: the agent runs as a child process on this host, which the
 * gateway web client (a phone) does not have — so the card is hidden there
 * rather than offering a control that cannot work.
 */
export function AcpAgentsCard() {
  const { t } = useTranslation(["settings", "common"]);
  const [agents, setAgents] = useState<AcpAgentConfig[]>(() => loadAcpAgents());
  const selected = useRuntimeStore((s) => s.defaultRuntime);
  const [editing, setEditing] = useState<AcpAgentConfig | null>(null);
  const [adding, setAdding] = useState(false);
  if (!isTauri) return null;

  const apply = (next: AcpAgentConfig[], nextSelected: string | null) => {
    saveAcpAgents(next);
    useRuntimeStore.getState().setDefaultRuntime(nextSelected);
    setAgents(next);
  };

  const select = (id: string | null) => {
    if (id !== selected) apply(agents, id);
  };

  const save = (agent: AcpAgentConfig) => {
    const exists = agents.some((a) => a.id === agent.id);
    const next = exists ? agents.map((a) => (a.id === agent.id ? agent : a)) : [...agents, agent];
    setEditing(null);
    setAdding(false);
    // A running process was started from the old command: stop it, and the
    // next message starts the new one (its conversations resume there).
    if (exists) stopAcpAgent(agent.id);
    apply(next, selected);
  };

  const remove = (id: string) => {
    const next = agents.filter((a) => a.id !== id);
    // Removing the default falls back to the bundled runtime; the app must
    // never default to an agent that is no longer configured.
    stopAcpAgent(id);
    apply(next, selected === id ? null : selected);
  };

  return (
    <Section title={t("acp.title")} hint={t("acp.hint")} flush>
      <div className="divide-y divide-faint">
        <RuntimeRow
          title={t("acp.bundled")}
          subtitle={t("acp.bundledHint")}
          selected={selected === null}
          onSelect={() => select(null)}
        />

        {agents.map((agent) =>
          editing?.id === agent.id ? (
            <AgentForm
              key={agent.id}
              initial={agent}
              onCancel={() => setEditing(null)}
              onSave={save}
            />
          ) : (
            <RuntimeRow
              key={agent.id}
              title={agent.name}
              subtitle={[agent.command, formatCommandArgs(agent.args)].filter(Boolean).join(" ")}
              mono
              selected={selected === agent.id}
                  onSelect={() => select(agent.id)}
              actions={
                <>
                  <button
                    className={iconBtn()}
                    aria-label={t("acp.edit")}
                    title={t("acp.edit")}
                    onClick={() => {
                      setAdding(false);
                      setEditing(agent);
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className={iconBtn("hover:text-error")}
                    aria-label={t("acp.remove")}
                    title={t("acp.remove")}
                    onClick={() => remove(agent.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              }
            />
          ),
        )}

        {adding ? (
          <AgentForm
            initial={{ id: newAcpAgentId(agents), name: "", command: "", args: [] }}
            onCancel={() => setAdding(false)}
            onSave={save}
          />
        ) : (
          <div className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={ghostBtn()}
                onClick={() => {
                  setEditing(null);
                  setAdding(true);
                }}
              >
                <Plus size={13} />
                {t("acp.add")}
              </button>
              {/* One click for the agents this app was verified against — still
                  an ordinary entry afterwards, editable like any other. */}
              {ACP_PRESETS.filter((p) => !agents.some((a) => a.name === p.name)).map((preset) => (
                <button
                  key={preset.name}
                  className={ghostBtn("text-muted")}
                  onClick={() => save({ ...preset, args: [...preset.args], id: newAcpAgentId(agents) })}
                >
                  <Plus size={13} />
                  {preset.name}
                </button>
              ))}
            </div>
            <p className="mt-2.5 text-xs leading-relaxed text-muted">{t("acp.limits")}</p>
          </div>
        )}
      </div>
    </Section>
  );
}

/** One selectable runtime: the bundled one, or a configured ACP agent. */
function RuntimeRow({
  title,
  subtitle,
  mono = false,
  selected,
  onSelect,
  actions,
}: {
  title: string;
  subtitle: string;
  mono?: boolean;
  selected: boolean;
  onSelect: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={title}
        onClick={onSelect}
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2",
        )}
      >
        {selected && <Check size={9} />}
      </button>
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 text-left"
      >
        <div className="text-[13px] font-medium text-text">{title}</div>
        <div className={cn("mt-0.5 truncate text-xs text-muted", mono && "font-mono")}>
          {subtitle}
        </div>
      </button>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

/** Add / edit one agent: a name, a command, and its arguments. */
function AgentForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: AcpAgentConfig;
  onCancel: () => void;
  onSave: (agent: AcpAgentConfig) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [name, setName] = useState(initial.name);
  const [command, setCommand] = useState(initial.command);
  const [args, setArgs] = useState(formatCommandArgs(initial.args));

  const submit = () => {
    const cmd = command.trim();
    if (!cmd) return;
    onSave({
      id: initial.id,
      name: name.trim() || cmd,
      command: cmd,
      args: parseCommandArgs(args),
    });
  };

  return (
    <div className="space-y-2 px-4 py-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("acp.namePlaceholder")}
        aria-label={t("acp.nameLabel")}
        className={inputCls("w-full")}
      />
      <input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={t("acp.commandPlaceholder")}
        aria-label={t("acp.commandLabel")}
        className={inputCls("w-full font-mono")}
        spellCheck={false}
      />
      <input
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={t("acp.argsPlaceholder")}
        aria-label={t("acp.argsLabel")}
        className={inputCls("w-full font-mono")}
        spellCheck={false}
      />
      <div className="flex gap-2">
        <button className={accentBtn()} onClick={submit} disabled={!command.trim()}>
          {t("common:actions.save")}
        </button>
        <button className={ghostBtn()} onClick={onCancel}>
          {t("common:actions.cancel")}
        </button>
      </div>
    </div>
  );
}

// Color-based hover/disabled, never `opacity` (which flickers in WKWebView).
const accentBtn = (extra = "") =>
  cn(
    "flex h-8 shrink-0 items-center gap-1.5 rounded-input bg-accent px-3 text-[13px] font-medium",
    "text-accent-fg transition-colors hover:bg-accent/90 disabled:bg-accent/50",
    extra,
  );
const ghostBtn = (extra = "") =>
  cn(
    "flex h-8 shrink-0 items-center gap-1.5 rounded-input border border-border px-3 text-[13px]",
    "text-text transition-colors hover:bg-surface-2",
    extra,
  );
const iconBtn = (extra = "") =>
  cn(
    "flex h-7 w-7 items-center justify-center rounded-input text-muted",
    "transition-colors hover:bg-surface-2 hover:text-text",
    extra,
  );
