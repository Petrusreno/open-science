import { useTranslation } from "react-i18next";
import * as Tooltip from "@radix-ui/react-tooltip";
import { copyReference, sessionReference } from "@/lib/agentReference";
import type { MessageSender } from "@/lib/messageSenders";
import { useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";

/** One line of what was sent, for a badge that speaks for several (a terminal's). */
export interface SentLine {
  time: string;
  who: string;
  text: string;
}

/**
 * Who sent something that was not the owner's — an agent of another
 * conversation, or a web account — on a message or a terminal. A badge,
 * because a conversation's title is long: hovering opens a card with the whole
 * title and its id (and `lines`, when given), and clicking an agent's badge
 * copies that conversation's reference — the lines right-click copies — so it
 * can be handed straight to another agent ("reply to whoever asked").
 */
export function SenderBadge({
  sender,
  lines,
  className,
}: {
  sender: MessageSender;
  lines?: SentLine[];
  className?: string;
}) {
  const { t } = useTranslation("session");
  const agent = sender.viaId !== undefined;
  const title = sender.viaSession ?? sender.viaId ?? "";
  const label = agent
    ? t("message.sentByAgentFull", { session: title, id: sender.viaId })
    : t("message.sentByAccount", { account: sender.account });
  // Type, not a chip: a muted "From" and the name, nothing around them — a
  // pill with an icon sat on the message like a sticker.
  const cls = cn(
    "group/sender flex max-w-[70%] items-baseline gap-1 text-[11px] leading-4 text-muted",
    className,
  );
  const name = agent ? (sender.account ? `${sender.account} · ${title}` : title) : sender.account;
  const face = (
    <>
      <span className="shrink-0 opacity-70">{t("message.from")}</span>
      <span className={cn("truncate text-text/70", agent && "decoration-1 underline-offset-2 group-hover/sender:underline")}>
        {name}
      </span>
    </>
  );
  const copy = () => {
    const id = sender.viaId!;
    const s = useRuntimeStore.getState().sessions.find((x) => x.id === id);
    void copyReference(sessionReference({ id, title: s?.title ?? title, directory: s?.directory }), t("reference.copied"));
  };

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          {agent ? (
            <button type="button" className={cls} aria-label={label} onClick={copy}>
              {face}
            </button>
          ) : (
            <span className={cls} aria-label={label} tabIndex={0}>
              {face}
            </span>
          )}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            // eslint-disable-next-line i18next/no-literal-string -- Radix placement, not UI copy
            side="bottom"
            // eslint-disable-next-line i18next/no-literal-string -- Radix placement, not UI copy
            align="end"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 w-[280px] overflow-hidden rounded-card border border-border bg-surface text-left text-text shadow-pop"
          >
            <div className="px-3 py-2.5">
              <div className="text-[11px] text-muted">
                {agent ? t("message.sentByAgentLabel") : t("message.sentByAccountLabel")}
              </div>
              <div className="mt-0.5 break-words text-[13px] font-medium leading-snug">
                {agent ? title : sender.account}
              </div>
              {agent && (
                <div className="mt-0.5 break-all font-mono text-[11px] text-muted">
                  {sender.account ? `${sender.account} · ${sender.viaId}` : sender.viaId}
                </div>
              )}
            </div>
            {lines && lines.length > 0 && (
              <div className="border-t border-faint px-3 py-2">
                <div className="mb-1 text-[11px] text-muted">{t("terminal.recentInput")}</div>
                <ul className="space-y-1">
                  {lines.map((l, i) => (
                    <li key={i} className="grid grid-cols-[auto_1fr] gap-x-2 text-[12px] leading-snug">
                      <span className="tabular-nums text-muted">{l.time}</span>
                      <span className="min-w-0">
                        <span className="text-muted">{l.who}</span>
                        <span className="block truncate font-mono text-[11.5px]">{l.text}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {agent && (
              <div className="border-t border-faint px-3 py-1.5 text-[11px] text-muted">{t("message.clickToCopyRef")}</div>
            )}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
