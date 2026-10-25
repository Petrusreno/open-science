import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Check, ListEnd, Paperclip, Pencil, Trash2, X } from "lucide-react";
import { useRuntimeStore, type QueuedPrompt } from "@/lib/runtime";

const NO_QUEUE: QueuedPrompt[] = [];

/**
 * The messages typed while this session's turn runs, waiting their turn. A
 * strip attached to the top of the composer: each row can be edited, removed,
 * or sent now — mid-turn, "now" steers it into the running turn. The runtime
 * sends the head by itself when a turn ends on its own (see `queuedPrompts`).
 * Renders nothing when the queue is empty.
 */
export function QueueDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("session");
  const queue = useRuntimeStore((s) => s.queuedPrompts[sessionId] ?? NO_QUEUE);
  const running = useRuntimeStore((s) => !!s.runningSessions[sessionId]);
  const edit = useRuntimeStore((s) => s.editQueuedPrompt);
  const remove = useRuntimeStore((s) => s.removeQueuedPrompt);
  const sendNow = useRuntimeStore((s) => s.sendQueuedPrompt);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  if (queue.length === 0) return null;

  const save = () => {
    if (!editing || !editing.text.trim()) return;
    edit(sessionId, editing.id, editing.text.trim());
    setEditing(null);
  };
  const iconButton =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-border/60 hover:text-text disabled:opacity-40";

  return (
    <ul
      aria-label={t("composer.queue.aria")}
      // Attached to the composer card below it: narrower, square bottom, no
      // bottom border — one surface with the card rather than a second card.
      className="mx-5 max-h-40 overflow-y-auto rounded-t-2xl border border-b-0 border-border/70 bg-surface-2 px-1.5 py-1"
    >
      {queue.map((q) => (
        <li key={q.id} className="flex min-w-0 items-center gap-2 py-0.5 pl-1.5 text-sm">
          <ListEnd size={14} className="shrink-0 text-muted" aria-hidden />
          {editing?.id === q.id ? (
            <>
              <input
                autoFocus
                aria-label={t("composer.queue.edit")}
                className="min-w-0 flex-1 bg-transparent text-text outline-none"
                value={editing.text}
                onChange={(e) => setEditing({ id: q.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
              <button className={iconButton} aria-label={t("composer.queue.save")} title={t("composer.queue.save")} disabled={!editing.text.trim()} onClick={save}>
                <Check size={13} />
              </button>
              <button className={iconButton} aria-label={t("composer.queue.cancelEdit")} title={t("composer.queue.cancelEdit")} onClick={() => setEditing(null)}>
                <X size={13} />
              </button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-text" title={q.text}>
                {q.text}
              </span>
              {q.attachments && (
                <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted">
                  <Paperclip size={11} aria-hidden />
                  {q.attachments.length}
                </span>
              )}
              <button className={iconButton} aria-label={t("composer.queue.edit")} title={t("composer.queue.edit")} onClick={() => setEditing({ id: q.id, text: q.text })}>
                <Pencil size={13} />
              </button>
              <button className={iconButton} aria-label={t("composer.queue.remove")} title={t("composer.queue.remove")} onClick={() => remove(sessionId, q.id)}>
                <Trash2 size={13} />
              </button>
              <button
                className={iconButton}
                aria-label={running ? t("composer.queue.steer") : t("composer.queue.sendNow")}
                title={running ? t("composer.queue.steer") : t("composer.queue.sendNow")}
                onClick={() => sendNow(sessionId, q.id)}
              >
                <ArrowUp size={13} />
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
