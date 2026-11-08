import { OFFLINE_TITLE } from "./v2-basket-read-only";
import V2Info from "./V2Info";
import { sharedEntryDisabled, sharedEntryName, sharedEntryQuantity, type SharedBasketEntry } from "./v2-basket-share";
import { basketQuantityLabel } from "./v2-basket-share-labels";

/**
 * A basket copy opened from its link (#panier=…): its articles, and the choice to add the missing ones
 * or replace the basket with it; or why the link cannot be opened (`entries` is null). The basket page
 * does the import.
 */
export default function V2BasketLinkImport({ entries, importing, error, readOnly, onImport, onClose }: {
  entries: SharedBasketEntry[] | null; importing: boolean; error: string; readOnly: boolean;
  onImport: (mode: "add" | "replace") => void; onClose: () => void;
}) {
  return <section className="v2-shared-basket" aria-label="Panier partagé">
    {entries ? <>
      <h2>Panier partagé <V2Info>Ajouter conserve les articles et quantités déjà présents. Remplacer reprend exactement ce panier partagé.</V2Info></h2>
      <p>{entries.length} article{entries.length > 1 ? "s" : ""} dans ce lien. Les prix seront recalculés selon les magasins disponibles.</p>
      <ul>{entries.map((entry, index) => <li key={index}>{sharedEntryName(entry)} <span>· {basketQuantityLabel(sharedEntryQuantity(entry))}{sharedEntryDisabled(entry) ? " · exclu du calcul" : ""}</span></li>)}</ul>
      <div className="v2-shared-basket-actions"><button type="button" className="v2-button v2-button-primary" disabled={importing || readOnly} title={readOnly ? OFFLINE_TITLE : undefined} onClick={() => onImport("add")}>{importing ? "Importation…" : "Ajouter les articles manquants"}</button>
        <button type="button" className="v2-button v2-button-secondary" disabled={importing || readOnly} title={readOnly ? OFFLINE_TITLE : undefined} onClick={() => onImport("replace")}>Remplacer mon panier</button>
        <button type="button" className="v2-button v2-button-secondary" onClick={onClose}>Ignorer</button></div>
      {error && <p role="alert">{error}</p>}
    </> : <><h2>Lien de panier invalide</h2><p>Ce lien ne peut pas être ouvert.</p><button type="button" className="v2-button v2-button-secondary" onClick={onClose}>Fermer</button></>}
  </section>;
}
