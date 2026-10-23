import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, FolderOpen, Loader2, Puzzle, X } from "lucide-react";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { readArtifact, revealArtifact } from "@/lib/artifactFile";
import { isTauri } from "@/lib/tauri";
import { isGatewayWeb } from "@/lib/webMode";
import { toast } from "@/lib/toast";

/** What the detail view needs about one skill or agent. */
export interface EntryDetailTarget {
  kind: "skill" | "agent";
  name: string;
  description: string;
  /** Where the runtime loaded it from (skills only): a SKILL.md path. */
  location?: string;
  /** Already-translated source or mode label. */
  label?: string;
}

/** The SKILL.md body without its frontmatter: name and description are
 *  already the dialog's header. */
export function skillBody(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").trim();
}

/** A file the desktop can open: an absolute path (the runtime's `<built-in>`
 *  skill has none), and never in the web client, which cannot reach home. */
function readablePath(location?: string): string | null {
  if (!location || !isTauri || isGatewayWeb) return null;
  return /^(\/|[A-Za-z]:[\\/])/.test(location) ? location : null;
}

/**
 * One skill or agent, opened from its card: the full description, and for a
 * skill the instructions the agent actually reads (its SKILL.md), with the
 * file one click from Finder. Read-only — editing a skill is editing its file.
 */
export function EntryDetail({ entry, onClose }: { entry: EntryDetailTarget; onClose: () => void }) {
  const { t } = useTranslation("pages");
  const path = readablePath(entry.location);
  const [body, setBody] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">(path ? "loading" : "ready");

  useEffect(() => {
    if (!path) return;
    let live = true;
    readArtifact(path, "home")
      .then((file) => {
        if (!live) return;
        if (file?.encoding === "utf8") {
          setBody(skillBody(file.data));
          setState("ready");
        } else setState("failed");
      })
      .catch(() => live && setState("failed"));
    return () => {
      live = false;
    };
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const Icon = entry.kind === "agent" ? Bot : Puzzle;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={entry.name}
        className="flex max-h-full w-[720px] max-w-full flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card"
      >
        <header className="flex items-start gap-3 border-b border-faint px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] border border-border bg-surface-2">
            <Icon size={18} strokeWidth={1.5} className="text-muted" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 truncate text-[16px] font-medium text-text">{entry.name}</h2>
              {entry.label && (
                <span className="shrink-0 whitespace-nowrap rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                  {entry.label}
                </span>
              )}
            </div>
            {entry.description && (
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{entry.description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label={t("skills.detail.close")}
            className="rounded-input p-1 text-muted hover:bg-surface-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </header>

        {path && (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {state === "loading" ? (
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <Loader2 size={13} className="animate-spin" />
                {t("skills.detail.loading")}
              </p>
            ) : state === "failed" ? (
              <p className="text-[13px] text-muted">{t("skills.detail.unreadable")}</p>
            ) : body ? (
              <MarkdownViewer className="text-[14px]">{body}</MarkdownViewer>
            ) : (
              <p className="text-[13px] text-muted">{t("skills.detail.empty")}</p>
            )}
          </div>
        )}

        {path && (
          <footer className="flex items-center gap-3 border-t border-faint px-5 py-3">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={path}>
              {path}
            </span>
            <button
              onClick={() =>
                void revealArtifact(path, "home").catch((e) =>
                  toast.error(String(e instanceof Error ? e.message : e)),
                )
              }
              className="inline-flex shrink-0 items-center gap-1.5 rounded-input border border-border px-2.5 py-1.5 text-[13px] text-text hover:bg-surface-2"
            >
              <FolderOpen size={13} strokeWidth={1.5} />
              {t("skills.detail.reveal")}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
