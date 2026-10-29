import { useState } from "react";

type ImportResult = {
  products_imported: number; prices_imported: number;
  products_already_present: number; prices_already_present: number;
};
type StoreWarning = {
  source_id: number; retailer: string; name: string;
  city: string | null; postal_code: string | null;
  status: "deleted" | "inactive";
};
type ImportPreview = { stores: StoreWarning[]; approval_token: string | null };
const MAX_FILE_BYTES = 24 * 1024 * 1024;

async function message(response: Response): Promise<string> {
  const value: unknown = await response.json().catch(() => null);
  return value && typeof value === "object" && "detail" in value && typeof value.detail === "string"
    ? value.detail : `Transfert impossible (HTTP ${response.status}).`;
}

export default function V2TransferPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const deleted = preview?.stores.filter(store => store.status === "deleted") ?? [];
  const inactive = preview?.stores.filter(store => store.status === "inactive") ?? [];

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

  async function inspectData() {
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice(""); setPreview(null); setApproved(false);
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("Archive trop volumineuse (24 Mio maximum).");
      const response = await fetch("/api/v2/transfers/import/preview", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: await file.text(),
      });
      if (!response.ok) throw new Error(await message(response));
      setPreview(await response.json() as ImportPreview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Vérification impossible.");
    } finally { setBusy(false); }
  }

  async function importData() {
    if (!file || !preview || busy || inactive.length || (deleted.length && !approved)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (deleted.length && preview.approval_token) {
        headers["X-V2-Deleted-Store-Approval"] = preview.approval_token;
      }
      const response = await fetch("/api/v2/transfers/import", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers, body: await file.text(),
      });
      if (!response.ok) {
        setPreview(null); setApproved(false);
        throw new Error(await message(response));
      }
      const result = await response.json() as ImportResult;
      setNotice(`${result.products_imported} produit(s) et ${result.prices_imported} prix importé(s). ` +
        `${result.products_already_present} produit(s) et ${result.prices_already_present} prix déjà présents.`);
      setFile(null); setPreview(null); setApproved(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Import impossible.");
    } finally { setBusy(false); }
  }

  return <section className="v2-settings-card v2-transfer" aria-labelledby="v2-transfer-heading">
    <h2 id="v2-transfer-heading">Transférer produits et prix</h2>
    <p>Exportez les fiches produit publiées et leurs relevés de prix validés vers une autre installation de Price Checker. Les comptes, brouillons privés, paniers et recettes ne sont pas inclus.</p>
    <div className="v2-settings-actions">
      <button type="button" className="v2-button v2-button-secondary" disabled={busy}
        onClick={() => void exportData()}>Exporter un fichier JSON</button>
    </div>
    <label className="v2-transfer-file">Archive JSON d’une autre installation de Price Checker
      <input type="file" accept=".json,application/json" disabled={busy}
        onChange={event => {
          setFile(event.target.files?.[0] ?? null);
          setPreview(null); setApproved(false); setError(""); setNotice("");
        }} />
    </label>
    <div className="v2-settings-actions">
      <button type="button" className="v2-button v2-button-secondary" disabled={!file || busy}
        onClick={() => void inspectData()}>{busy ? "Vérification…" : "Vérifier l’archive"}</button>
    </div>
    {preview && <div className="v2-transfer-preview" role="group" aria-label="Résultat de la vérification">
      {preview.stores.length === 0 && <p>Aucun point de vente supprimé ou désactivé dans cette archive.</p>}
      {preview.stores.length > 0 && <>
        <h3>Points de vente à examiner</h3>
        <ul>{preview.stores.map(store => <li key={store.source_id}>
          <span className={`v2-transfer-badge v2-transfer-badge-${store.status}`}>
            {store.status === "deleted" ? "↻ Déjà supprimé" : "⏸ Désactivé"}
          </span>
          <strong>{store.retailer} — {store.name}</strong>
          {(store.city || store.postal_code) && <span>{[store.postal_code, store.city].filter(Boolean).join(" ")}</span>}
        </li>)}</ul>
      </>}
      {deleted.length > 0 && <label className="v2-transfer-approval">
        <input type="checkbox" checked={approved} disabled={busy}
          onChange={event => setApproved(event.target.checked)} />
        Je valide la réimportation {deleted.length === 1 ? "de ce point de vente supprimé" : "de ces points de vente supprimés"} et de leurs prix.
      </label>}
      {inactive.length > 0 && <p className="v2-schedule-error" role="alert">
        Réactivez {inactive.length === 1 ? "ce point de vente" : "ces points de vente"} avant l’import.
      </p>}
    </div>}
    <div className="v2-settings-actions">
      <button type="button" className="v2-button v2-button-primary"
        disabled={!file || !preview || busy || inactive.length > 0 || (deleted.length > 0 && !approved)}
        onClick={() => void importData()}>{busy ? "Transfert en cours…" : "Importer sur cette instance"}</button>
    </div>
    <p className="v2-settings-note">L’import est effectué entièrement ou pas du tout. Il peut être répété sans créer de doublon. Un conflit de code-barres ou un produit déjà importé puis modifié bloque l’archive entière, sans écraser les données locales.</p>
    {error && <p className="v2-schedule-error" role="alert">{error}</p>}
    {notice && <p className="v2-schedule-success" role="status">{notice}</p>}
  </section>;
}
