import { useState } from "react";
import { useTranslation } from "react-i18next";
import { gatewayOrigin, setGatewayToken } from "@/lib/webMode";

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
    "mt-3 h-10 w-full rounded-input border border-border bg-surface-2 px-3 text-sm outline-none focus:border-accent";
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void submit();
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg p-6 text-text">
      <form
        className="w-full max-w-sm rounded-card border border-border bg-surface p-7 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="text-lg font-semibold">{t("remote.title")}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          {useToken ? t("remote.connectPrompt") : t("remote.signInPrompt")}
        </p>
        {useToken ? (
          <input
            type="password"
            autoFocus
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={onEnter}
            placeholder={t("remote.token")}
            aria-label={t("remote.token")}
            className={field}
          />
        ) : (
          <>
            <input
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onEnter}
              placeholder={t("remote.accountName")}
              aria-label={t("remote.accountName")}
              className={field}
            />
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onEnter}
              placeholder={t("remote.password")}
              aria-label={t("remote.password")}
              className="mt-2 h-10 w-full rounded-input border border-border bg-surface-2 px-3 text-sm outline-none focus:border-accent"
            />
          </>
        )}
        {error && (
          <p className="mt-2 text-sm text-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !ready}
          className="mt-4 h-10 w-full rounded-input bg-accent text-sm font-medium text-white transition-opacity disabled:opacity-50"
        >
          {useToken ? t("remote.connect") : t("remote.signIn")}
        </button>
        <button
          type="button"
          onClick={() => {
            setUseToken((v) => !v);
            setError("");
          }}
          className="mt-3 w-full text-center text-[13px] text-muted hover:text-text"
        >
          {useToken ? t("remote.useAccount") : t("remote.useToken")}
        </button>
      </form>
    </div>
  );
}
