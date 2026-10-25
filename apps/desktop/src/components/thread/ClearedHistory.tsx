import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRuntimeStore } from "@/lib/runtime";
import { BlockList, type BlockHandlers } from "./BlockList";

/** Longest `/clear` chain walked — a guard against a corrupt (cyclic) record. */
const MAX_CHAIN = 50;

/**
 * What `/clear` left behind: the conversations it cleared, kept on screen
 * above the current one — like a terminal's scrollback after `clear`.
 *
 * Each earlier part is its own OpenCode session; the model of the current one
 * never sees it. So it renders faded and read-only (no edit, revert or retry —
 * those would act on a session this pane no longer drives), and the divider
 * under it says so in words. Repeated clears chain: the nearest part is shown,
 * older ones wait behind one row so a long chain does not load all at once.
 */
export function ClearedHistory({
  from,
  connected,
  handlers,
  onOpen,
}: {
  /** The session this pane was cleared from. */
  from: string;
  connected: boolean;
  /** The pane's handlers; only opening a file card carries over. */
  handlers: BlockHandlers;
  /** Show an earlier session in this pane. */
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation("session");
  // Oldest first. Joined into a string so the selector's result keeps its
  // identity across unrelated store updates.
  const chainKey = useRuntimeStore((s) => {
    const ids: string[] = [];
    for (let id: string | undefined = from; id && !ids.includes(id) && ids.length < MAX_CHAIN; id = s.clearedFrom[id])
      ids.unshift(id);
    return ids.join(" ");
  });
  const chain = chainKey.split(" ");
  const [showOlder, setShowOlder] = useState(false);
  const older = chain.length - 1;
  const shown = showOlder ? chain : chain.slice(-1);
  const earlierHandlers = useMemo(
    () => ({ onArtifactOpen: handlers.onArtifactOpen }),
    [handlers.onArtifactOpen],
  );

  return (
    <>
      {older > 0 && !showOlder && (
        <p className="mb-5 text-center text-xs text-muted">
          {t("localCommand.olderCleared", { count: older })}
          {" · "}
          <button
            type="button"
            onClick={() => setShowOlder(true)}
            className="underline-offset-2 hover:text-text hover:underline"
          >
            {t("localCommand.showOlder")}
          </button>
        </p>
      )}
      {shown.map((id, i) => (
        <ClearedPart
          key={id}
          sessionId={id}
          nearest={i === shown.length - 1}
          connected={connected}
          handlers={earlierHandlers}
          onOpen={() => onOpen(id)}
        />
      ))}
    </>
  );
}

/** One cleared session: its conversation, faded, then the divider. A part that
 *  cannot be loaded (deleted since) shows nothing — except the nearest divider,
 *  which marks where the current context begins and always stays. */
function ClearedPart({
  sessionId,
  nearest,
  connected,
  handlers,
  onOpen,
}: {
  sessionId: string;
  nearest: boolean;
  connected: boolean;
  handlers: BlockHandlers;
  onOpen: () => void;
}) {
  const { t } = useTranslation("session");
  const thread = useRuntimeStore((s) => s.threads[sessionId]);
  const exists = useRuntimeStore((s) => s.sessions.some((x) => x.id === sessionId));
  const loadHistory = useRuntimeStore((s) => s.loadHistory);
  const loaded = !!thread?.loaded && !thread.historyError;
  useEffect(() => {
    if (connected && !loaded) void loadHistory(sessionId);
  }, [connected, loaded, loadHistory, sessionId]);
  if (!nearest && !loaded) return null;

  return (
    <>
      {loaded && thread.blocks.length > 0 && (
        <div className="opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100">
          <BlockList blocks={thread.blocks} handlers={handlers} />
        </div>
      )}
      <div role="separator" aria-label={t("localCommand.clearedLabel")} className="my-5">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="h-px flex-1 bg-border" />
          <span className="shrink-0 font-medium">{t("localCommand.clearedLabel")}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
        {(nearest || exists) && (
          <p className="mt-1 text-center text-xs text-muted">
            {nearest && t("localCommand.clearedHint")}
            {nearest && exists && " · "}
            {exists && (
              <button
                type="button"
                onClick={onOpen}
                className="underline-offset-2 hover:text-text hover:underline"
              >
                {t("localCommand.openEarlier")}
              </button>
            )}
          </p>
        )}
      </div>
    </>
  );
}
