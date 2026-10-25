// Who sent each message of a conversation, from the gateway's audit log.
//
// The runtime stores a message's words, not who typed them. When colleagues
// share a workbench through web accounts, or an agent messages another
// conversation, the audit log has the answer: each `session.prompt` entry
// carries its sender and the message's first 500 characters. A message is
// matched to its entry by those words. Messages the owner sent themselves are
// not marked — on their own workbench, that is every unmarked one.
import { useCallback, useEffect, useState } from "react";
import { queryAudit, type AuditEntry } from "./tauri";
import { useRuntimeStore } from "./runtime";

export interface MessageSender {
  /** The account that sent it, or null when an agent sent it on the owner's behalf. */
  account: string | null;
  /** The conversation whose agent sent it: its id … */
  viaId?: string;
  /** … and its title, or its id when it has none. */
  viaSession?: string;
}

const squash = (s: string) => s.split(/\s+/).filter(Boolean).join(" ").slice(0, 200);
/** The audit keeps a long message's start and its length: `…… (812 characters)`. */
const unclip = (s: string) => s.replace(/… \(\d+ characters\)$/, "");

export function sendersFrom(
  entries: AuditEntry[],
  sessionId: string,
  titleOf: (id: string) => string | undefined = () => undefined,
): Map<string, MessageSender> {
  const out = new Map<string, MessageSender>();
  // Oldest first, so a text sent twice is credited to whoever sent it last.
  for (const e of [...entries].reverse()) {
    if (e.target !== sessionId || e.action !== "session.prompt" || !e.detail) continue;
    const account = e.actor.startsWith("account:") ? e.actor.slice("account:".length) : null;
    if (!account && !e.via) continue;
    out.set(squash(unclip(e.detail)), {
      account,
      ...(e.via ? { viaId: e.via, viaSession: titleOf(e.via) || e.via } : {}),
    });
  }
  return out;
}

/** `senderOf(text)` for this conversation's messages, refreshed as messages
 *  arrive (`userMessages` is how many there are). */
export function useMessageSenders(
  sessionId: string | null | undefined,
  userMessages: number,
): (text: string) => MessageSender | undefined {
  const [senders, setSenders] = useState<Map<string, MessageSender>>(() => new Map());
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const load = () =>
      void queryAudit({ target: sessionId, action: "session.prompt", limit: 1000 })
        .then((entries) => {
          if (cancelled) return;
          const { sessions } = useRuntimeStore.getState();
          setSenders(sendersFrom(entries, sessionId, (id) => sessions.find((s) => s.id === id)?.title));
        })
        .catch(() => {});
    load();
    // The gateway writes its audit line once the message is handed over, which
    // can be after the message itself reached this window: look again shortly.
    const again = window.setTimeout(load, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(again);
    };
  }, [sessionId, userMessages]);
  // Stable until the senders change: it rides on the thread's handlers, whose
  // identity decides whether the whole message list re-renders.
  return useCallback((text: string) => (senders.size ? senders.get(squash(text)) : undefined), [senders]);
}
