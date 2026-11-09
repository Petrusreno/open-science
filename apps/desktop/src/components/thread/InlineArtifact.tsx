import { memo, useEffect, useState } from "react";
import { ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArtifactBlock } from "@ai4s/shared";
import { cn } from "@/lib/cn";
import { fileInspectorFromBlock } from "@/lib/artifacts";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";
import { PaneHeaderClearsLights } from "@/components/inspector/RightPane";

/** How tall an inline preview may get before it is worth opening full-screen.
 *
 *  It replaces a FIXED `h-[min(460px,58vh)]`, and the difference is the whole
 *  point: a fixed height made every preview a scroll box — a short file left
 *  dead space, a tall one could only be read by scrolling INSIDE the
 *  conversation. WebKit latches a trackpad gesture to the innermost scroller
 *  under the pointer, so that inner box also swallowed the page scroll until it
 *  hit its own end, which is the "scroll conflict" this had. A max rather than a
 *  height means short content is its own size and scrolls nothing. */
const INLINE_MAX = "max-h-[min(70vh,720px)]";

/** A real workspace preview placed at the exact point where the agent invoked
 *  `present_artifact`. It reuses the inspector renderers, so inline and panel
 *  modes never disagree about how a file type should look.
 *
 *  Fold and full-screen ride the preview's OWN header, beside the kind badge and
 *  the history and open buttons — a second title bar stacked above it said the
 *  filename twice and put the controls on a row that was not the card. */
export const InlineArtifact = memo(function InlineArtifact({
  block,
  workspaceDirectory,
}: {
  block: ArtifactBlock;
  workspaceDirectory?: string;
}) {
  const { t } = useTranslation(["session", "common", "inspector"]);
  const [collapsed, setCollapsed] = useState(false);
  const [full, setFull] = useState(false);
  const inspector = fileInspectorFromBlock(block);

  // Escape closes the full view, from anywhere — the reader's hands are on the
  // keyboard and aiming at a close button is not where their attention is.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  if (inspector.variant === "notebook-file") return null;
  const title = block.presentation?.title ?? block.filename;

  const preview = (controls?: React.ReactNode, folded = false, embedded = true) => (
    <FilePreviewInspector
      data={inspector}
      workspaceDirectory={workspaceDirectory}
      embedded={embedded}
      title={block.presentation?.title}
      controls={controls}
      collapsed={folded}
    />
  );

  const iconBtn = "shrink-0 text-text hover:opacity-60";

  return (
    <>
      {/* Sized by its content up to a cap, not to a fixed height. */}
      <div className={cn("w-full overflow-hidden", !collapsed && INLINE_MAX)}>
        {preview(
          <>
            <button
              type="button"
              className={iconBtn}
              aria-label={t("artifact.maximize")}
              title={t("artifact.maximize")}
              onClick={() => setFull(true)}
            >
              <Maximize2 size={14} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className={iconBtn}
              aria-label={collapsed ? t("artifact.expand") : t("artifact.collapse")}
              title={collapsed ? t("artifact.expand") : t("artifact.collapse")}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((c) => !c)}
            >
              <ChevronRight
                size={14}
                strokeWidth={1.5}
                className={cn("transition-transform duration-200", !collapsed && "rotate-90")}
              />
            </button>
          </>,
          collapsed,
        )}
      </div>

      {/* Full view fills the window edge to edge, like a maximized panel: no
          margin, backdrop or second title row. Its header is the window's top
          row, so it clears the traffic lights the way a maximized pane does. */}
      {full && (
        <div className="fixed inset-0 z-50 bg-surface" role="dialog" aria-modal="true" aria-label={title}>
          <PaneHeaderClearsLights.Provider value>
            {preview(
              <button
                type="button"
                className={iconBtn}
                aria-label={t("inspector:shell.restorePanel")}
                title={t("inspector:shell.restorePanel")}
                onClick={() => setFull(false)}
              >
                <Minimize2 size={14} strokeWidth={1.5} />
              </button>,
              false,
              false,
            )}
          </PaneHeaderClearsLights.Provider>
        </div>
      )}
    </>
  );
});
