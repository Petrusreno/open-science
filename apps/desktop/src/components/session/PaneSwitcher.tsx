import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  FileText,
  FolderTree,
  MessageSquare,
  NotebookPen,
  Presentation,
  Terminal as TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { leaves, type PaneLeaf, type PaneNode } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";
import { useTransientScrollbar } from "@/lib/transientScrollbar";
import { usePaneNames } from "./GroupTabs";

function paneIcon(leaf: PaneLeaf): LucideIcon {
  if (leaf.artifact) return Presentation;
  switch (leaf.content?.kind) {
    case "terminal":
      return TerminalIcon;
    case "files":
      return FolderTree;
    case "notebook":
      return NotebookPen;
    case "editor":
      return FileText;
    default:
      return MessageSquare;
  }
}

/**
 * The phone's way between the panes of one Screen.
 *
 * A phone shows one pane at a time, so a Screen split on the desktop used to
 * come up as whichever pane happened to be focused, with no sign the others
 * existed and no way to reach them. This row names every pane of the Screen,
 * in the order they sit on the desktop, and a tap shows that one. A Screen of
 * one pane has nothing to choose between and shows no row.
 */
export function PaneSwitcher({
  tree,
  focusedLeafId,
  onFocus,
}: {
  tree: PaneNode | null;
  focusedLeafId: string | null;
  onFocus: (leafId: string) => void;
}) {
  const { t } = useTranslation(["session", "nav"]);
  const { describe, sessionTitle } = usePaneNames();
  const running = useRuntimeStore((s) => s.runningSessions);
  const panes = tree ? leaves(tree) : [];
  const rowRef = useTransientScrollbar();

  // The pane on display is always in view, as in the Screen bar.
  useEffect(() => {
    if (!focusedLeafId) return;
    document
      .querySelector(`[data-pane-chip="${CSS.escape(focusedLeafId)}"]`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [focusedLeafId]);

  if (panes.length < 2) return null;

  const label = (leaf: PaneLeaf): string => {
    if (leaf.content) return describe(leaf.content) ?? t("live.header.untitled");
    if (leaf.artifact)
      return leaf.artifact.presentation?.title || leaf.artifact.filename;
    if (!leaf.sessionId) return t("nav:history.draft");
    return sessionTitle(leaf.sessionId) ?? t("live.header.untitled");
  };

  return (
    <div
      ref={rowRef}
      role="tablist"
      aria-label={t("group.panes")}
      className="flex h-9 shrink-0 select-none items-stretch gap-1 scrollbar-transient overflow-x-auto border-b border-faint px-2"
    >
      {panes.map((leaf) => {
        const active = leaf.id === focusedLeafId;
        const Icon = paneIcon(leaf);
        // A conversation still working says so, so the user knows which pane
        // to look at without opening each one.
        const busy = !leaf.content && !leaf.artifact && !!leaf.sessionId && !!running[leaf.sessionId];
        return (
          <button
            key={leaf.id}
            role="tab"
            aria-selected={active}
            data-pane-chip={leaf.id}
            onClick={() => onFocus(leaf.id)}
            className={cn(
              "-mb-px flex min-w-0 max-w-[180px] shrink-0 items-center gap-1.5 border-b-2 px-2 text-[12px]",
              active ? "border-accent text-text" : "border-transparent text-muted",
            )}
          >
            <Icon size={13} className="shrink-0" />
            <span className="truncate">{label(leaf)}</span>
            {busy && <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}
