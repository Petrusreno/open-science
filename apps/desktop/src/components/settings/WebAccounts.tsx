import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserRound } from "lucide-react";
import { buttonCls, inputCls } from "@/components/settings/inputCls";
import { toast } from "@/lib/toast";
import { deleteWebAccount, listWebAccounts, setWebAccount } from "@/lib/tauri";

const MIN_PASSWORD = 8;

/** Settings › Remote access › Accounts: the names a browser signs in with.
 *  An account's session and Screens follow it to any address, which a token
 *  kept per browser address cannot do. */
export function WebAccounts() {
  const { t } = useTranslation("settings");
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  /** The account whose password is being changed, and the new one. */
  const [resetting, setResetting] = useState<{ name: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void listWebAccounts().then(setNames);
  }, []);
  useEffect(refresh, [refresh]);

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      refresh();
      return true;
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (await run(() => setWebAccount(name.trim(), password), t("remote.accountAdded", { name: name.trim() }))) {
      setName("");
      setPassword("");
    }
  };

  const input = inputCls("h-8 min-w-0 flex-1");
  const canAdd = !busy && !!name.trim() && password.length >= MIN_PASSWORD;

  return (
    <div className="mt-2.5 space-y-2">
      {names.length === 0 ? (
        <p className="text-[13px] text-muted">{t("remote.accountNone")}</p>
      ) : (
        <ul className="divide-y divide-[var(--border-faint)] rounded-input border border-border">
          {names.map((n) => (
            <li key={n} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <UserRound size={14} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-text">{n}</span>
              {resetting?.name === n ? (
                <>
                  <input
                    type="password"
                    autoFocus
                    autoComplete="new-password"
                    value={resetting.password}
                    onChange={(e) => setResetting({ name: n, password: e.target.value })}
                    placeholder={t("remote.accountNewPassword")}
                    aria-label={t("remote.accountNewPassword")}
                    className={inputCls("h-8 w-44")}
                  />
                  <button
                    type="button"
                    className={buttonCls()}
                    disabled={busy || resetting.password.length < MIN_PASSWORD}
                    onClick={() =>
                      void run(() => setWebAccount(n, resetting.password), t("remote.accountReset", { name: n })).then(
                        (ok) => ok && setResetting(null),
                      )
                    }
                  >
                    {t("remote.accountSave")}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-input px-2 py-1 text-[13px] text-muted hover:bg-surface-2"
                    onClick={() => setResetting(null)}
                  >
                    {t("common:actions.cancel", "Cancel")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="shrink-0 rounded-input px-2 py-1 text-[13px] text-muted hover:bg-surface-2 hover:text-text"
                    disabled={busy}
                    onClick={() => setResetting({ name: n, password: "" })}
                  >
                    {t("remote.accountChangePassword")}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-input px-2 py-1 text-[13px] text-error hover:bg-error/10"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(t("remote.accountDeleteConfirm", { name: n }))) return;
                      void run(() => deleteWebAccount(n), t("remote.accountDeleted", { name: n }));
                    }}
                  >
                    {t("remote.accountDelete")}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canAdd) void add();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          placeholder={t("remote.accountName")}
          aria-label={t("remote.accountName")}
          className={input}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder={t("remote.accountPasswordHint", { count: MIN_PASSWORD })}
          aria-label={t("remote.password")}
          className={input}
        />
        <button type="submit" className={buttonCls()} disabled={!canAdd}>
          {t("remote.accountAdd")}
        </button>
      </form>
    </div>
  );
}
