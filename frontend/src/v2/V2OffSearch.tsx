import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAppMode } from "./useAppMode";
import { barcodeProduct } from "./v2-barcode";
import { OFF_PRODUCT_PAGE, searchOff, type OffMatch } from "./v2-off-browser";

type Found = { results: OffMatch[]; ours: Record<string, number> };
// Searches already made in this tab: going back to a results page does not ask Open Food Facts again.
const made = new Map<string, Found>();
const madeKey = (terms: string, world: boolean) => (world ? "world|" : "france|") + terms;

async function ourProducts(codes: string[]): Promise<Record<string, number>> {
  if (!codes.length) return {};
  const response = await fetch("/api/v2/products/by-barcodes", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codes: codes.slice(0, 20) }),
  });
  if (!response.ok) return {};
  const payload = await response.json() as { matches?: Record<string, number> };
  return payload.matches ?? {};
}

/**
 * The catalogue page's search at Open Food Facts, read by this browser for a submitted search (Enter in
 * a search bar) or on a click, never as you type: products sold in France, marked when ours, otherwise
 * opened here on request (only its barcode is then imported, and the connectors can read its prices)
 * or proposed as a full sheet.
 */
export default function V2OffSearch({ query, submitted = "" }: { query: string; submitted?: string }) {
  const navigate = useNavigate();
  const { mode, canSwitch: signedIn } = useAppMode();
  const terms = query.trim();
  // Products sold in France by default; the switch widens the search to every country.
  const [world, setWorld] = useState(false);
  const [found, setFound] = useState<{ key: string; value: Found } | null>(() =>
    made.has(madeKey(terms, false)) ? { key: madeKey(terms, false), value: made.get(madeKey(terms, false))! } : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function search(everywhere = world) {
    if (terms.length < 2 || busy) return;
    const key = madeKey(terms, everywhere);
    if (made.has(key)) { setFound({ key, value: made.get(key)! }); return; }
    setBusy("search"); setError("");
    try {
      const results = await searchOff(terms, undefined, { france: !everywhere });
      const value = { results, ours: await ourProducts(results.map(item => item.code)) };
      made.set(key, value);
      setFound({ key, value });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Recherche indisponible."); }
    finally { setBusy(null); }
  }
  // A submitted search (Enter in a search bar) is a request: it is also made at Open Food Facts, once.
  const searchRef = useRef(search);
  useEffect(() => { searchRef.current = search; });
  const autoTerms = submitted.trim();
  useEffect(() => {
    if (autoTerms.length >= 2 && !made.has(madeKey(autoTerms, false))) void searchRef.current();
  }, [autoTerms]);
  async function open(code: string) {
    setBusy(code); setError("");
    try { navigate("/v2/produits/" + (await barcodeProduct(code)).id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Ouverture impossible."); setBusy(null); }
  }
  const shown = found && found.key === madeKey(terms, world) ? found.value : null;
  function changeWorld(next: boolean) {
    setWorld(next);
    // Already showing results: switching is a request for the other set (one search, or none if made).
    if (found && found.key === madeKey(terms, world)) void search(next);
  }
  return <section className="v2-off-search-catalogue" aria-labelledby="v2-off-search-heading">
    <div className="v2-off-search-catalogue-head">
      <h2 id="v2-off-search-heading">Chez Open Food Facts</h2>
      <button type="button" className="v2-button v2-button-secondary" disabled={terms.length < 2 || busy !== null} onClick={() => { void search(); }}>
        {busy === "search" ? "Recherche…" : terms.length >= 2 ? `Chercher « ${terms.slice(0, 40)} » chez Open Food Facts` : "Chercher aussi chez Open Food Facts"}</button>
    </div>
    <label className="v2-off-world"><input type="checkbox" checked={world} disabled={busy !== null} onChange={event => changeWorld(event.target.checked)} />
      Inclure les produits vendus hors de France</label>
    <p className="v2-catalogue-source">Leur catalogue compte bien plus de produits. La recherche part de votre navigateur quand vous validez une recherche (Entrée) ou cliquez, jamais pendant la saisie : votre adresse IP est alors transmise à Open Food Facts.</p>
    {error && <p role="alert">{error}</p>}
    {shown && (shown.results.length === 0 ? <p>{world ? "Aucun produit trouvé chez Open Food Facts." : "Aucun produit vendu en France trouvé chez Open Food Facts."}</p>
      : <ul className="v2-off-search-results">{shown.results.map(item => {
        const ours = shown.ours[item.code];
        return <li key={item.code}>
          {item.image ? <img src={item.image} alt="" loading="lazy" /> : <span className="v2-off-search-noimage" aria-hidden="true" />}
          <span className="v2-off-search-text"><strong>{item.name || "Sans nom"}</strong>
            <small>{[item.brand, item.quantity, item.code].filter(Boolean).join(" · ")}</small></span>
          <span className="v2-off-search-actions">
            {ours ? <Link className="v2-button v2-button-secondary" to={"/v2/produits/" + ours}>Voir la fiche</Link>
              : signedIn ? <button type="button" className="v2-button v2-button-secondary" disabled={busy !== null} onClick={() => { void open(item.code); }}>
                {busy === item.code ? "Ouverture…" : "Ouvrir ici"}</button> : null}
            {!ours && mode === "contribute" && <Link to={"/v2/produits/nouveau?ean=" + encodeURIComponent(item.code)}>Proposer</Link>}
            <a href={OFF_PRODUCT_PAGE + item.code} target="_blank" rel="noreferrer" aria-label={`${item.name || item.code} chez Open Food Facts`}>OFF ↗</a>
          </span>
        </li>;
      })}</ul>)}
    {shown && shown.results.length > 0 && !signedIn && <p><Link to="/v2/connexion">Connectez-vous</Link> pour ouvrir ces produits ici, les ajouter au panier ou noter un prix.</p>}
    {shown && shown.results.length > 0 && <p className="v2-catalogue-source">Résultats d’Open Food Facts (ODbL). « Ouvrir ici » ajoute seulement son code-barres à notre catalogue : vous pouvez alors l’ajouter au panier ou y noter un prix, et nos relevés automatiques cherchent son prix.</p>}
  </section>;
}
