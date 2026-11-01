import { useState } from "react";
import type { V2User } from "./v2-auth-api";
import V2AccountDeletion from "./V2AccountDeletion";

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
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = "price-checker-v2-account.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (reason) { setExportError(String(reason)); }
    finally { setExporting(false); }
  }
  return <>
    <section className="v2-settings-card" aria-labelledby="v2-account-data-heading">
      <h2 id="v2-account-data-heading">Mes données</h2>
      <p>Téléchargez votre compte, vos brouillons, recettes, relevés et signalements au format JSON.</p>
      <button type="button" className="v2-button v2-button-secondary" disabled={exporting}
        onClick={() => { void exportAccount(); }}>{exporting ? "Préparation…" : "Exporter mes données"}</button>
      {exportError && <p role="alert">{exportError}</p>}
    </section>
    {user.role !== "admin" && <V2AccountDeletion userId={user.id} onDeleted={onDeleted} />}
  </>;
}
