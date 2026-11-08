import { useState } from "react";
import V2Info from "./V2Info";
import type { V2User } from "./v2-auth-api";
import V2AccountDeletion from "./V2AccountDeletion";
import { saveBlob } from "./v2-download";
import { errorText } from "./v2-http";

/** The signed-in person's own data: export and, for non-administrators, account deletion. */
export default function V2SettingsAccount({ user, onDeleted }: { user: V2User; onDeleted: (cleared: boolean) => void }) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  async function exportAccount() {
    if (exporting) return;
    setExporting(true); setExportError("");
    try {
      const response = await fetch("/api/v2/account/export", {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) throw new Error("L’export n’a pas pu être préparé.");
      saveBlob(await response.blob(), "price-checker-v2-account.json");
    } catch (reason) { setExportError(errorText(reason, "L’export n’a pas pu être préparé.")); }
    finally { setExporting(false); }
  }
  return <>
    <section className="v2-settings-card" aria-labelledby="v2-account-data-heading">
      <h2 id="v2-account-data-heading">Mes données <V2Info>Téléchargez votre compte, vos brouillons, recettes, relevés et signalements au format JSON.</V2Info></h2>
      <button type="button" className="v2-button v2-button-secondary" disabled={exporting}
        onClick={() => { void exportAccount(); }}>{exporting ? "Préparation…" : "Exporter mes données"}</button>
      {exportError && <p role="alert">{exportError}</p>}
    </section>
    {user.role !== "admin" && <V2AccountDeletion userId={user.id} onDeleted={onDeleted} />}
  </>;
}
