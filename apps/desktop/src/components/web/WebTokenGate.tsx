import { useState } from "react";
import { useTranslation } from "react-i18next";
import { gatewayOrigin, setGatewayToken } from "@/lib/webMode";
import logo from "@/assets/logo.webp";

/** Pre-auth screen for the gateway-served web client, before the real app
 *  boots. An account (name + password, made in the desktop's Settings) is the
 *  usual way in: its session and its Screens follow it to any address. The
 *  access token is the other way, for whoever was handed one. See
 *  docs/rfc/remote-access-gateway.md. */
export function WebTokenGate({ onConnect }: { onConnect: () => void }) {
  const { t } = useTranslation(["settings"]);
  const [useToken, setUseToken] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const ready = useToken ? !!token.trim() : !!name.trim() && !!password;

  const signIn = async (): Promise<string | null> => {
    const r = await fetch(`${gatewayOrigin()}/v1/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), password }),
    });
    if (r.ok) return ((await r.json()) as { token: string }).token;
    if (r.status === 429) {
      const { retryAfter } = (await r.json().catch(() => ({}))) as { retryAfter?: number };
      setError(t("remote.signInLocked", { minutes: Math.max(1, Math.ceil((retryAfter ?? 60) / 60)) }));
    } else {
      setError(r.status === 401 ? t("remote.signInInvalid") : t("remote.error"));
    }
    return null;
  };

  const checkToken = async (): Promise<string | null> => {
    const tok = token.trim();
    const r = await fetch(`${gatewayOrigin()}/v1/whoami`, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.ok) return tok;
    setError(t("remote.error"));
    return null;
  };

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const credential = useToken ? await checkToken() : await signIn();
      if (credential) {
        // A session is used exactly where the token would be.
        setGatewayToken(credential);
        onConnect();
        return;
      }
    } catch {
      setError(t("remote.error"));
    }
    setBusy(false);
  };

  const field =
    "h-10 w-full rounded-input border border-border bg-surface px-3 text-sm text-text outline-none transition-colors placeholder:text-muted/60 focus:border-text/40";
  const label = "mb-1.5 block text-xs text-muted";
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void submit();
  };

  // No card: the page IS the form. Left-aligned, the app's own brand mark on
  // top, one column of type — the same quiet register as the workbench behind it.
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg px-6 py-12 text-text">
      <form
        className="w-full max-w-[340px] pb-[8vh]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-2">
          <img src={logo} alt="" className="h-6 w-6" />
          {/* eslint-disable-next-line i18next/no-literal-string -- product brand name, not translated across locales (see AGENTS.md) */}
          <span className="font-serif text-[17px] font-semibold">Open Science</span>
        </div>

        <h1 className="mt-12 text-[22px] font-semibold leading-tight">
          {useToken ? t("remote.token") : t("remote.signIn")}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {useToken ? t("remote.connectPrompt") : t("remote.signInPrompt")}
        </p>

        <div className="mt-8 space-y-4">
          {useToken ? (
            <div>
              {/* The heading already names the field. */}
              <input
                aria-label={t("remote.token")}
                type="password"
                autoFocus
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={onEnter}
                className={field}
              />
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="gate-name" className={label}>
                  {t("remote.accountName")}
                </label>
                <input
                  id="gate-name"
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={onEnter}
                  className={field}
                />
              </div>
              <div>
                <label htmlFor="gate-password" className={label}>
                  {t("remote.password")}
                </label>
                <input
                  id="gate-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={onEnter}
                  className={field}
                />
              </div>
            </>
          )}
        </div>

        {error && (
          <p className="mt-3 text-[13px] text-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !ready}
          className="mt-6 h-10 w-full rounded-input bg-text text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          {useToken ? t("remote.connect") : t("remote.signIn")}
        </button>
        <button
          type="button"
          onClick={() => {
            setUseToken((v) => !v);
            setError("");
          }}
          className="mt-5 text-[13px] text-muted underline-offset-4 hover:text-text hover:underline"
        >
          {useToken ? t("remote.useAccount") : t("remote.useToken")}
        </button>
      </form>
    </div>
  );
}
