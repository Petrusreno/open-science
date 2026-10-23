import { useTranslation } from "react-i18next";
import { Row, Section } from "@/components/settings/Section";
import { buttonCls } from "@/components/settings/inputCls";
import { useRuntimeStore } from "@/lib/runtime";
import { clearGatewayToken, gatewayOrigin, gatewayToken } from "@/lib/webMode";

/** Settings › General in the web client: who this browser is signed in as,
 *  and the way out. Signing out of an account ends its session on the desktop
 *  too; with the bare token it only forgets the token here. */
export function WebSignedIn() {
  const { t } = useTranslation("settings");
  const user = useRuntimeStore((s) => s.webUser);

  const signOut = async () => {
    if (user) {
      const token = gatewayToken();
      await fetch(`${gatewayOrigin()}/v1/logout`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).catch(() => {});
    }
    clearGatewayToken();
    window.location.reload();
  };

  return (
    <Section title={t("remote.signedInTitle")}>
      <Row
        title={user ? t("remote.signedInAs", { name: user }) : t("remote.signedInToken")}
        hint={user ? t("remote.signedInHint") : t("remote.signedInTokenHint")}
        control={
          <button type="button" className={buttonCls()} onClick={() => void signOut()}>
            {t("remote.signOut")}
          </button>
        }
      />
    </Section>
  );
}
