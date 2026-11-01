import { Fragment, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import V2BarcodeScanner from "./V2BarcodeScanner";
import { BarcodeIcon, SearchIcon } from "./V2SiteIcons";
import { useCatalogueSearch, type Suggest } from "./useCatalogueSearch";
import { resolveBarcodePath } from "./v2-barcode";
import {
  SEARCH_MAX_LENGTH, SEARCH_MIN_CHARS, isBarcode, sameBarcode, type SearchScope, type SearchableProduct,
} from "./v2-catalogue-search";
import "./v2-catalogue-search.css";

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? "s" : ""}`;

/**
 * One search bar for names, brands and barcodes, with a scan icon. Results follow what is typed.
 * `children` (the filters) sit between the bar and the results.
 */
export default function V2CatalogueSearch<T extends SearchableProduct & { id: number }>({ value, onChange, scope, suggest, renderProduct, children }: {
  value: string; onChange: (value: string) => void; scope: SearchScope; suggest: Suggest<T>;
  renderProduct: (product: T) => ReactNode; children?: ReactNode;
}) {
  const navigate = useNavigate();
  const view = useCatalogueSearch(value, scope, suggest);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const code = isBarcode(value) ? value.trim() : "";

  async function open(barcode: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { navigate(await resolveBarcodePath(barcode)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "La recherche a échoué. Réessayez."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (code) void open(code); }
  function detected(scanned: string) { setScannerOpen(false); onChange(scanned); void open(scanned); }

  const status = view.kind === "idle" ? (view.short ? `Saisissez au moins ${SEARCH_MIN_CHARS} caractères.` : "")
    : view.kind === "loading" ? "Recherche…"
    : view.kind === "list" ? (view.items.length ? plural(view.items.length, "produit") : "Aucun produit trouvé.")
    : view.kind === "many" ? `${plural(view.total, "produit")} correspondent. Précisez votre recherche pour les afficher.`
    : view.kind === "limited" ? `Trop de recherches. Nouvelle tentative automatique dans ${view.retryAfter} s.`
    : view.message;
  const known = view.kind === "list" && view.items.some(item => sameBarcode(item.data.ean ?? "", code));

  return <section className="v2-dynamic-search" aria-label="Recherche dans le catalogue">
    <form className="v2-dynamic-search-bar" role="search" onSubmit={submit}>
      <label className="v2-site-sr-only" htmlFor="v2-dynamic-search-field">Rechercher un produit, une marque ou un code-barres</label>
      <SearchIcon />
      <input id="v2-dynamic-search-field" type="search" value={value} maxLength={SEARCH_MAX_LENGTH} autoComplete="off"
        enterKeyHint="search" placeholder="Nom, marque ou code-barres" onChange={event => { onChange(event.target.value); setError(""); }} />
      <button type="button" className="v2-dynamic-search-scan" aria-label="Scanner un code-barres" title="Scanner un code-barres"
        disabled={busy} onClick={() => setScannerOpen(true)}><BarcodeIcon /></button>
    </form>
    {children}
    <p className="v2-dynamic-search-status" role={view.kind === "error" ? "alert" : "status"} aria-live="polite">{status}</p>
    {code && <button type="button" className="v2-button v2-button-secondary v2-dynamic-search-barcode" disabled={busy} onClick={() => void open(code)}>
      {busy ? "Recherche…" : known ? `Ouvrir la fiche du code-barres ${code} →`
        : view.kind === "list" ? `Préparer une fiche pour le code-barres ${code} →` : `Ouvrir ou préparer la fiche du code-barres ${code} →`}
    </button>}
    {error && <p role="alert">{error}</p>}
    {view.kind === "list" && view.items.length > 0 && <div className="v2-workspace-list">
      {view.items.map(item => <Fragment key={item.id}>{renderProduct(item)}</Fragment>)}
    </div>}
    {scannerOpen && <V2BarcodeScanner onClose={() => setScannerOpen(false)} onDetected={detected} />}
  </section>;
}
