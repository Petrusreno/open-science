import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, Check, ChevronRight, Plus, Puzzle, Search, X } from "lucide-react";
import type { McpServer, ProviderInfo } from "@ai4s/sdk";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";
import { isGatewayWeb } from "@/lib/webMode";
import { deleteSpecialist, isTauri, listSpecialists, saveSpecialist } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { listProvidersWithAvailability } from "@/lib/zenModels";
import type { Specialist } from "@/lib/specialists";
import { SpecialistAvatar } from "@/components/specialists/SpecialistAvatar";
import { SpecialistEditor } from "@/components/specialists/SpecialistEditor";

/**
 * What this workbench can do, and what it runs on.
 *
 * Laid out as a settings-style list: a title with one short line under it,
 * then each kind as a section of roomy rows (icon tile, name, one line of
 * description). The toolchain sits last — a fact to glance at, not the reason
 * anyone comes here. Earlier versions put a paragraph of path-laden small print
 * above a dense two-column grid, and the page read as a wall of 12px text.
 */
export function SkillsPage() {
  const { t } = useTranslation(["pages", "common"]);
  // Individual selectors, not a bare `useRuntimeStore()`: the latter re-renders
  // this page on every unrelated store mutation, including the SSE fold storm of
  // an active session (#34).
  const skills = useRuntimeStore((s) => s.skills);
  const agents = useRuntimeStore((s) => s.agents);
  const tools = useRuntimeStore((s) => s.tools);
  const status = useRuntimeStore((s) => s.status);
  const loadCatalog = useRuntimeStore((s) => s.loadCatalog);
  const detectTools = useRuntimeStore((s) => s.detectTools);
  const connected = status === "ready";

  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState(false);
  // Specialists are files the desktop writes (#144); the web client has no
  // path to them, so there they simply list as the subagents they are.
  const canEditSpecialists = isTauri && !isGatewayWeb;
  const [specialists, setSpecialists] = useState<Specialist[]>([]);
  const [connectors, setConnectors] = useState<McpServer[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [editing, setEditing] = useState<Specialist | "new" | null>(null);
  const reloadRuntimeConfig = useRuntimeStore((s) => s.reloadRuntimeConfig);

  useEffect(() => {
    if (connected) void loadCatalog();
    void detectTools();
  }, [connected, loadCatalog, detectTools]);

  const refreshSpecialists = async () => {
    if (!canEditSpecialists) return;
    setSpecialists(await listSpecialists().catch(() => []));
  };
  useEffect(() => {
    void refreshSpecialists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEditor = async (target: Specialist | "new") => {
    // Connectors and models are read when the editor opens, not with the page:
    // they are only needed there, and either may have changed in Settings since.
    const client = getClient();
    const [mcp, catalog] = await Promise.all([
      client?.listMcpServers().catch(() => null),
      client ? listProvidersWithAvailability(client).catch(() => null) : null,
    ]);
    setConnectors(mcp ?? []);
    setProviders(catalog ?? []);
    setEditing(target);
  };

  const onSaveSpecialist = async (specialist: Specialist, create: boolean) => {
    await reloadRuntimeConfig(() => saveSpecialist(specialist, create));
    await refreshSpecialists();
    setEditing(null);
    toast.success(
      create
        ? t("skills.specialists.created", { id: specialist.id })
        : t("skills.specialists.saved", { id: specialist.id }),
    );
  };

  const onDeleteSpecialist = async (id: string) => {
    await reloadRuntimeConfig(() => deleteSpecialist(id));
    await refreshSpecialists();
    setEditing(null);
    toast.success(t("skills.specialists.deleted", { id }));
  };

  const entries = useMemo<Entry[]>(() => {
    const all: Entry[] = [
      ...skills.map((s) => ({
        kind: "skill" as const,
        name: s.name,
        description: s.description,
        tag: sourceOf(s.location),
      })),
      ...agents.map((a) => ({
        kind: "agent" as const,
        name: a.name,
        description: a.description,
        // The RAW mode: an SDK that grows a new one must still show it rather
        // than show nothing. `agentModeLabel` translates the ones we know.
        tag: a.mode,
      })),
    ];
    const needle = query.trim().toLowerCase();
    return all
      .filter(
        (e) =>
          !needle ||
          e.name.toLowerCase().includes(needle) ||
          (e.description ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, agents, query]);
  const skillRows = entries.filter((e) => e.kind === "skill");
  const specialistIds = new Set(specialists.map((s) => s.id));
  // A specialist is an agent too; it is listed once, in its own section.
  const agentRows = entries.filter((e) => e.kind === "agent" && !specialistIds.has(e.name));
  const needle = query.trim().toLowerCase();
  const specialistRows = specialists.filter(
    (s) => !needle || s.id.includes(needle) || s.description.toLowerCase().includes(needle),
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-10 py-10">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-2xl text-text">{t("skills.title")}</h1>
            <p className="mt-1 text-[14px] text-muted">{t("skills.subtitle")}</p>
          </div>
          {connected && (
            <label className="relative w-56">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("skills.search")}
                aria-label={t("skills.search")}
                className="h-9 w-full rounded-input border border-border bg-surface pl-8 pr-2 text-[13px] text-text outline-none placeholder:text-muted focus:border-accent/50"
              />
            </label>
          )}
          <InstallSkill installing={installing} setInstalling={setInstalling} connected={connected} />
        </header>

        {!connected ? (
          <p className="mt-10 text-[14px] text-muted">{t("skills.disconnected")}</p>
        ) : entries.length === 0 ? (
          <p className="mt-10 text-[14px] text-muted">
            {query ? t("skills.noMatch", { query }) : t("skills.skillsListSection.empty")}
          </p>
        ) : (
          <>
            {skillRows.length > 0 && (
              <Section title={t("skills.skillsListSection.heading")} count={skillRows.length}>
                {skillRows.map((entry) => (
                  <EntryRow key={`skill:${entry.name}`} entry={entry} />
                ))}
              </Section>
            )}
            {canEditSpecialists && (specialistRows.length > 0 || !needle) && (
              <Section
                title={t("skills.specialists.heading")}
                count={specialists.length || undefined}
                hint={t("skills.specialists.hint")}
                action={
                  <button
                    onClick={() => void openEditor("new")}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-input border border-border px-2.5 text-[13px] text-text hover:bg-surface-2"
                  >
                    <Plus size={13} strokeWidth={1.5} />
                    {t("skills.specialists.new")}
                  </button>
                }
              >
                {specialists.length === 0 ? (
                  <button
                    onClick={() => void openEditor("new")}
                    className="w-full rounded-card border border-dashed border-border px-5 py-6 text-left hover:bg-surface-2/60"
                  >
                    <p className="text-[14px] text-text">{t("skills.specialists.emptyTitle")}</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-muted">
                      {t("skills.specialists.emptyBody")}
                    </p>
                  </button>
                ) : (
                  specialistRows.map((s) => (
                    <SpecialistRow key={s.id} specialist={s} onOpen={() => void openEditor(s)} />
                  ))
                )}
              </Section>
            )}
            {agentRows.length > 0 && (
              <Section title={t("skills.agentsSection.heading")} count={agentRows.length}>
                {agentRows.map((entry) => (
                  <EntryRow key={`agent:${entry.name}`} entry={entry} />
                ))}
              </Section>
            )}
          </>
        )}

        {/* The toolchain, last: which runtimes the agent's shell will find. */}
        {!isGatewayWeb && (
          <Section title={t("skills.environment.sectionTitle")}>
            {tools.length === 0 ? (
              <p className="text-[14px] text-muted">{t("skills.environment.detectionUnavailable")}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {tools.map((tool) => (
                    <span
                      key={tool.name}
                      title={
                        tool.found
                          ? (tool.version ?? t("skills.environment.found"))
                          : t("skills.environment.notFound")
                      }
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px]",
                        tool.found
                          ? "border-border bg-surface text-text"
                          : "border-dashed border-border bg-transparent text-muted",
                      )}
                    >
                      {tool.found ? (
                        <Check size={12} className="shrink-0 text-ok" />
                      ) : (
                        <X size={12} className="shrink-0 text-muted" />
                      )}
                      {tool.name}
                      {tool.found ? (
                        tool.version && (
                          <span className="font-mono text-[12px] text-muted">
                            {shortVersion(tool.version)}
                          </span>
                        )
                      ) : (
                        // Said, not implied: whether the machine has R is not
                        // something to make the reader hover for.
                        <span>{t("skills.environment.notFound")}</span>
                      )}
                      {tool.managed && (
                        <span className="rounded bg-surface-2 px-1 text-[11px] text-muted">
                          {t("skills.environment.appManaged")}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-muted">{t("skills.environment.note")}</p>
              </>
            )}
          </Section>
        )}
      </div>

      {editing !== null && (
        <SpecialistEditor
          initial={editing === "new" ? null : editing}
          takenIds={agents.map((a) => a.name)}
          skills={skills}
          connectors={connectors}
          providers={providers}
          onSave={onSaveSpecialist}
          onDelete={onDeleteSpecialist}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** One specialist: the whole row opens its editor. */
function SpecialistRow({ specialist, onOpen }: { specialist: Specialist; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      title={specialist.description || undefined}
      className="group -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-center gap-4 rounded-xl px-2 py-2.5 text-left hover:bg-surface-2/60"
    >
      <SpecialistAvatar id={specialist.id} color={specialist.color} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[15px] text-text">{specialist.id}</h3>
        <p className="mt-0.5 truncate text-[13px] text-muted">{specialist.description}</p>
      </div>
      <ChevronRight
        size={16}
        className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

interface Entry {
  kind: "skill" | "agent";
  name: string;
  description: string;
  tag?: string;
}

function Section({
  title,
  count,
  hint,
  action,
  children,
}: {
  title: string;
  count?: number;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-baseline gap-2 text-[15px] font-medium text-text">
            {title}
            {count !== undefined && <span className="font-normal text-muted">{count}</span>}
          </h2>
          {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One capability: an icon tile, the name with where it came from, and one
 *  line of description — the whole text on hover. */
function EntryRow({ entry }: { entry: Entry }) {
  const { t } = useTranslation("pages");
  const label = entry.kind === "agent" ? agentModeLabel(entry.tag, t) : sourceLabel(entry.tag, t);
  const Icon = entry.kind === "agent" ? Bot : Puzzle;
  return (
    <article className="flex min-w-0 items-center gap-4 py-2.5" title={entry.description || undefined}>
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface">
        <Icon size={18} strokeWidth={1.5} className="text-muted" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 truncate text-[15px] text-text">{entry.name}</h3>
          {label && (
            <span className="shrink-0 whitespace-nowrap rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
              {label}
            </span>
          )}
        </div>
        {entry.description && <p className="mt-0.5 truncate text-[13px] text-muted">{entry.description}</p>}
      </div>
    </article>
  );
}

/**
 * Installing a skill, behind a button.
 *
 * It is the rarest thing done on this page and it used to own the top of it —
 * a permanent three-row textarea plus a two-line explanation, above the list
 * that is the reason anyone comes here.
 */
function InstallSkill({
  connected,
  installing,
  setInstalling,
}: {
  connected: boolean;
  installing: boolean;
  setInstalling: (value: boolean) => void;
}) {
  const { t } = useTranslation("pages");
  const navigate = useNavigate();
  const installSkill = useRuntimeStore((s) => s.installSkill);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const onInstall = async () => {
    if (!text.trim()) return;
    setInstalling(true);
    const result = await installSkill(text.trim());
    setInstalling(false);
    if (!result) return; // failed — the store surfaced the reason
    setText("");
    setOpen(false);
    // A pasted SKILL.md is already installed (the store toasts it); anything
    // else runs in an agent session worth watching.
    if (result.kind === "session") navigate(`/live/${result.id}`);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={!connected}
        title={connected ? undefined : t("skills.install.hintDisconnected")}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-input bg-text px-3 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-40"
      >
        <Plus size={13} strokeWidth={1.5} />
        {t("skills.install.cta")}
      </button>
    );
  }

  return (
    <div className="w-full rounded-card bg-surface-2 p-3">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("skills.install.placeholder")}
        aria-label={t("skills.install.cta")}
        rows={3}
        className="w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent/50"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void onInstall()}
          disabled={!connected || !text.trim() || installing}
          className="rounded-input bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
        >
          {installing ? t("skills.install.starting") : t("skills.install.cta")}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-input px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface-2"
        >
          {t("common:actions.cancel", "Cancel")}
        </button>
        <span className="min-w-0 flex-1 text-[11px] text-muted">{t("skills.install.hintConnected")}</span>
      </div>
    </div>
  );
}

type SkillSource = "builtin" | "project" | "user";

/** Where a skill came from, read off the path OpenCode reports. Windows paths
 *  arrive with backslashes, so match on a normalized copy. */
function sourceOf(location?: string): SkillSource | undefined {
  if (!location) return undefined;
  const path = location.replace(/\\/g, "/");
  // OpenCode's own built-in skill reports "<built-in>" (v1) or /builtin/… (v2).
  if (path === "<built-in>" || path.includes("/builtin/")) return "builtin";
  // The app profile's skills dir: bundled packs, except the `user/` subtree the
  // skill installer writes to.
  if (path.includes("/xdg-config/opencode/skills/")) {
    return path.includes("/xdg-config/opencode/skills/user/") ? "user" : "builtin";
  }
  if (path.includes("/.opencode/")) return "project";
  // ~/.claude/skills, ~/.agents/skills, and config-declared skill paths.
  return "user";
}

type Say = ReturnType<typeof useTranslation<"pages">>["t"];

function sourceLabel(source: string | undefined, t: Say): string | undefined {
  if (source === "builtin") return t("skills.skillsListSection.source.builtin");
  if (source === "project") return t("skills.skillsListSection.source.project");
  if (source === "user") return t("skills.skillsListSection.source.user");
  return undefined;
}

// AgentInfo.mode is typed `string` (external SDK), but OpenCode only ever
// emits "primary" | "subagent" | "all" — see useRuntimeStore's a.mode ===
// "primary" check. Those three are translated; anything a future SDK adds is
// shown as it came, which is more useful than showing nothing.
function agentModeLabel(mode: string | undefined, t: Say): string | undefined {
  if (mode === "primary") return t("skills.agentsSection.agentMode.primary");
  if (mode === "subagent") return t("skills.agentsSection.agentMode.subagent");
  if (mode === "all") return t("skills.agentsSection.agentMode.all");
  return mode;
}

/** `Python 3.11.7` → `3.11.7`: the chip already says which tool it is, and the
 *  full `Rscript (R) version 4.6.1 (2026-06-24)` line is a tooltip's job. */
function shortVersion(version: string): string {
  return /(\d+\.[\d.]*\d)/.exec(version)?.[1] ?? version;
}
