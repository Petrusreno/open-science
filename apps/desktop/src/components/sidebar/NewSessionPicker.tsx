import { useTranslation } from "react-i18next";
import { Command, defaultFilter } from "cmdk";
import { Plus } from "lucide-react";
import { DEFAULT_PROJECT, selectActiveProjectId, useLayoutStore } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { projectIdForSession } from "@/lib/projectScope";
import { timeAgo } from "@/lib/relativeTime";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** cmdk row values — internal ids, never shown. */
// eslint-disable-next-line i18next/no-literal-string -- internal id, not UI copy
const DEFAULT_VALUE = "project:default";
const valueOf = (projectId: string) => (projectId ? `project:${projectId}` : DEFAULT_VALUE);

/** Match on the row's name, never on its internal id. */
const matchShown = (_value: string, search: string, keywords?: string[]) =>
  defaultFilter((keywords ?? []).join(" "), search);

/**
 * "New" asks where: the sidebar's New sits above every project, so it cannot
 * say by itself where a conversation would go — this does. Centered, in the
 * same shape as ⌘J.
 *
 * The project on display comes first and is already highlighted, so Enter
 * starts the conversation there: asking costs a keyboard user nothing. The
 * rest follow by when they were last used, then the default sessions, then a new
 * project. ⌘T skips the question entirely (the hint says so).
 */
export function NewSessionPicker({
  onPick,
  onNewProject,
  onClose,
}: {
  /** A project id, or DEFAULT_PROJECT for a session in no project. */
  onPick: (projectId: string) => void;
  onNewProject?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["nav", "session"]);
  const projects = useRuntimeStore((s) => s.projects);
  const sessions = useRuntimeStore((s) => s.sessions);
  const current = useLayoutStore(selectActiveProjectId);

  const usage = new Map<string, { count: number; last?: number }>();
  for (const s of sessions) {
    if (s.parentId) continue;
    const id = projectIdForSession(s.id, sessions, projects);
    const u = usage.get(id) ?? { count: 0 };
    u.count += 1;
    if (s.updated && (u.last ?? 0) < s.updated) u.last = s.updated;
    usage.set(id, u);
  }
  const now = Date.now();
  const detail = (id: string) => {
    const u = usage.get(id);
    return u ? t("jump.projectDetail", { count: u.count, ago: timeAgo(u.last, now) }) : t("jump.projectEmpty");
  };
  const others = projects
    .filter((p) => p.id !== current)
    .sort((a, b) => (usage.get(b.id)?.last ?? b.createdAt) - (usage.get(a.id)?.last ?? a.createdAt));
  const currentProject = projects.find((p) => p.id === current);
  // The same name the Screen bar gives these sessions, so the two never
  // disagree about where a conversation went.
  const defaultName = t("session:group.defaultProject");

  // One quiet shape for every row: name left, a muted fact right. The folder
  // icon on every line said nothing a list of projects does not already say.
  const row =
    "flex h-9 cursor-pointer items-center gap-3 rounded-input px-3 text-[13.5px] text-text data-[selected=true]:bg-surface-2";
  const fact = "shrink-0 text-xs tabular-nums text-muted";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 pt-[14vh]"
      onClick={onClose}
      // Esc is the picker's: it must not reach the session page and interrupt a turn.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("newPicker.title")}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px]"
      >
        <Command
          label={t("newPicker.title")}
          filter={matchShown}
          defaultValue={valueOf(current)}
          className="overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        >
          <div className="border-b border-border px-4 pb-2.5 pt-3">
            <div className="text-xs text-muted">{t("newPicker.title")}</div>
            <Command.Input
              autoFocus
              placeholder={t("newPicker.search")}
              className="mt-1 w-full bg-transparent text-[15px] text-text outline-none placeholder:text-muted/70"
            />
          </div>
          <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted">{t("jump.noResults")}</Command.Empty>
            {/* Where the user is: first, highlighted, Enter. */}
            <Command.Item
              value={valueOf(current)}
              keywords={[currentProject?.name ?? defaultName]}
              onSelect={() => onPick(current)}
              className={row}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{currentProject?.name ?? defaultName}</span>
              <span className={fact}>{t("newPicker.current")}</span>
            </Command.Item>
            {others.map((p) => (
              <Command.Item key={p.id} value={valueOf(p.id)} keywords={[p.name]} onSelect={() => onPick(p.id)} className={row}>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className={fact}>{detail(p.id)}</span>
              </Command.Item>
            ))}
            {current !== DEFAULT_PROJECT && (
              <Command.Item value={DEFAULT_VALUE} keywords={[defaultName]} onSelect={() => onPick(DEFAULT_PROJECT)} className={row}>
                <span className="min-w-0 flex-1 truncate">{defaultName}</span>
                <span className={fact}>{detail(DEFAULT_PROJECT)}</span>
              </Command.Item>
            )}
            {onNewProject && (
              <>
                <Command.Separator className="mx-3 my-1.5 h-px bg-border" />
                <Command.Item value="new-project" keywords={[t("newPicker.newProject")]} onSelect={onNewProject} className={`${row} text-muted data-[selected=true]:text-text`}>
                  <Plus size={14} className="-ml-0.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t("newPicker.newProject")}</span>
                </Command.Item>
              </>
            )}
          </Command.List>
          <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted">
            <span>
              {/* eslint-disable-next-line i18next/no-literal-string -- key name, not UI copy */}
              <Kbd>↵</Kbd> {t("newPicker.hintCreate")}
            </span>
            <span>
              {/* eslint-disable-next-line i18next/no-literal-string -- keyboard shortcut, not UI copy */}
              <Kbd>{isMac ? "⌘T" : "Ctrl T"}</Kbd> {t("newPicker.hintQuick")}
            </span>
            <span className="ml-auto">
              {/* eslint-disable-next-line i18next/no-literal-string -- key name, not UI copy */}
              <Kbd>esc</Kbd> {t("jump.hints.close")}
            </span>
          </div>
        </Command>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="mr-1 font-sans text-[11px] text-text/70">{children}</kbd>;
}
