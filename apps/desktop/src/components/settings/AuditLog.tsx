import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { inputCls } from "@/components/settings/inputCls";
import { cn } from "@/lib/cn";
import { listWebAccounts, queryAudit, type AuditEntry } from "@/lib/tauri";
import { useRuntimeStore } from "@/lib/runtime";

const PAGE = 50;

/** `2026-10-24T16:13:47Z` in this computer's time, without the year when it is this year's. */
function localTime(utc: string): string {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return utc;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    year: sameYear ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Settings › Remote access › Audit: who did what through remote access —
 *  which account (or which conversation's agent) sent a message, deleted a
 *  conversation, typed into a terminal, signed in. Flat rows, newest first. */
export function AuditLog() {
  const { t } = useTranslation("settings");
  const sessions = useRuntimeStore((s) => s.sessions);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [actor, setActor] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    void queryAudit({ actor: actor || undefined, limit })
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [actor, limit]);
  useEffect(load, [load]);
  useEffect(() => {
    void listWebAccounts().then(setAccounts);
  }, []);

  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.title || id;
  const who = (e: AuditEntry) =>
    e.actor === "admin" ? t("remote.audit.you") : e.actor.replace(/^account:/, "");
  const action = (e: AuditEntry) =>
    t(`remote.audit.actions.${e.action.replace(".", "_")}`, { defaultValue: e.action });
  const target = (e: AuditEntry) => (e.target?.startsWith("ses_") ? sessionName(e.target) : e.target);

  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-2">
        <select
          className={inputCls("h-8 w-auto")}
          value={actor}
          onChange={(e) => {
            setActor(e.target.value);
            setLimit(PAGE);
          }}
          aria-label={t("remote.audit.who")}
        >
          <option value="">{t("remote.audit.everyone")}</option>
          <option value="admin">{t("remote.audit.you")}</option>
          {accounts.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          aria-label={t("remote.audit.refresh")}
          title={t("remote.audit.refresh")}
          className="rounded-input p-2 text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(loading && "animate-spin")} />
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">{t("remote.audit.empty")}</p>
      ) : (
        <ul className="mt-2 divide-y divide-[var(--border-faint)]">
          {entries.map((e, i) => (
            <li key={`${e.time}-${i}`} className="py-2 text-[13px]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="tabular-nums text-muted">{localTime(e.time)}</span>
                <span className="font-medium text-text">{who(e)}</span>
                {e.via && (
                  <span className="text-muted">{t("remote.audit.agentIn", { session: sessionName(e.via) })}</span>
                )}
                <span className="text-text">{action(e)}</span>
                {e.target && <span className="min-w-0 truncate text-muted">{target(e)}</span>}
                {(e.status < 200 || e.status >= 300) && (
                  <span className="text-error">{t("remote.audit.failed", { status: e.status })}</span>
                )}
              </div>
              {e.detail && (
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[12.5px] text-muted" title={e.detail}>
                  {e.detail}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {entries.length >= limit && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE)}
          className="mt-1 text-[13px] text-accent hover:underline"
        >
          {t("remote.audit.more")}
        </button>
      )}
    </div>
  );
}
