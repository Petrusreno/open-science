import { useEffect, useState } from "react";
import { queryAudit, type AuditEntry } from "@/lib/tauri";
import { useRuntimeStore } from "@/lib/runtime";
import { terminalShellId } from "@/lib/terminalTransport";
import type { MessageSender } from "@/lib/messageSenders";
import { SenderBadge } from "@/components/thread/SenderBadge";

/** How often to look for new input from outside while the window is visible. */
const POLL_MS = 10_000;

/** Typed by someone other than the owner: another conversation's agent
 *  (`osd term send`), or a web account. The owner at their own keyboard is not
 *  news, and the desktop window's keystrokes never reach the gateway at all. */
const fromOutside = (e: AuditEntry) => !!e.via || e.actor.startsWith("account:");

/**
 * The terminal's header says who last typed into it from outside, read from
 * the gateway's audit log: hover for the last few lines and who sent each,
 * click (for an agent) to copy that conversation's reference.
 */
export function TerminalSenders({ leafId }: { leafId: string }) {
  const [recent, setRecent] = useState<AuditEntry[]>([]);
  useEffect(() => {
    const shell = terminalShellId(leafId);
    let stopped = false;
    const load = () =>
      void queryAudit({ target: shell, action: "terminal.input", limit: 20 })
        .then((all) => !stopped && setRecent(all.filter(fromOutside).slice(0, 5)))
        .catch(() => {});
    load();
    const timer = window.setInterval(() => document.visibilityState === "visible" && load(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [leafId]);
  if (recent.length === 0) return null;

  const titleOf = (id: string) => useRuntimeStore.getState().sessions.find((s) => s.id === id)?.title || id;
  const senderOf = (e: AuditEntry): MessageSender => ({
    account: e.actor.startsWith("account:") ? e.actor.slice("account:".length) : null,
    ...(e.via ? { viaId: e.via, viaSession: titleOf(e.via) } : {}),
  });
  const who = (s: MessageSender) => [s.account, s.viaSession].filter(Boolean).join(" · ");
  const when = (utc: string) => new Date(utc).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const lines = recent.map((e) => ({ time: when(e.time), who: who(senderOf(e)), text: e.detail ?? "" }));
  return <SenderBadge sender={senderOf(recent[0])} lines={lines} className="max-w-[12rem]" />;
}
