import { useState } from "react";

type ImportResult = {
  products_imported: number; prices_imported: number;
  products_already_present: number; prices_already_present: number;
};
const MAX_FILE_BYTES = 24 * 1024 * 1024;

async function message(response: Response): Promise<string> {
  const value: unknown = await response.json().catch(() => null);
  return value && typeof value === "object" && "detail" in value && typeof value.detail === "string"
    ? value.detail : `Transfert impossible (HTTP ${response.status}).`;
}

export default function V2TransferPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function exportData() {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v2/transfers/export", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(await message(response));
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `price-checker-v2-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Archive des produits et prix publiés téléchargée.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Export impossible.");
    } finally { setBusy(false); }
  }

  async function importData() {
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("Archive trop volumineuse (24 Mio maximum).");
      const response = await fetch("/api/v2/transfers/import", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: await file.text(),
      });
      if (!response.ok) throw new Error(await message(response));
      const result = await response.json() as ImportResult;
      setNotice(`${result.products_imported} produit(s) et ${result.prices_imported} prix importé(s). ` +
        `${result.products_already_present} produit(s) et ${result.prices_already_present} prix déjà présents.`);
      setFile(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Import impossible.");
    } finally { setBusy(false); }
  }

  return <section className="v2-settings-card v2-transfer" aria-labelledby="v2-transfer-heading">
    <h2 id="v2-transfer-heading">Transférer produits et prix</h2>
    <p>Exportez les fiches produit publiées et leurs relevés de prix validés vers une autre instance V2. Les comptes, brouillons privés, paniers et recettes ne sont pas inclus.</p>
    <div className="v2-settings-actions">
      <button type="button" className="v2-button v2-button-secondary" disabled={busy}
        onClick={() => void exportData()}>Exporter un fichier JSON</button>
    </div>
    <label className="v2-transfer-file">Archive JSON d’une autre instance V2
      <input type="file" accept=".json,application/json" disabled={busy}
        onChange={event => { setFile(event.target.files?.[0] ?? null); setError(""); }} />
    </label>
    <div className="v2-settings-actions">
      <button type="button" className="v2-button v2-button-primary" disabled={!file || busy}
        onClick={() => void importData()}>{busy ? "Transfert en cours…" : "Importer sur cette instance"}</button>
    </div>
    <p className="v2-settings-note">L’import est atomique et peut être répété sans doublon. Un conflit de code-barres ou un produit déjà importé puis modifié bloque l’archive entière, sans écraser les données locales.</p>
    {error && <p className="v2-schedule-error" role="alert">{error}</p>}
    {notice && <p className="v2-schedule-success" role="status">{notice}</p>}
  </section>;
}
