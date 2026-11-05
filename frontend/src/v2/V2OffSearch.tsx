import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAppMode } from "./useAppMode";
import { barcodeProduct } from "./v2-barcode";
import { OFF_PRODUCT_PAGE, searchOff, type OffMatch } from "./v2-off-browser";

type Found = { results: OffMatch[]; ours: Record<string, number> };

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
 * The catalogue page's search at Open Food Facts, read by this browser on a click (never as you type):
 * products sold in France, marked when ours, otherwise opened here on request (a product holding only
 * its barcode is then created) or proposed as a full sheet.
 */
export default function V2OffSearch({ query }: { query: string }) {
  const navigate = useNavigate();
  const { mode, canSwitch: signedIn } = useAppMode();
  const terms = query.trim();
  const [found, setFound] = useState<{ terms: string; value: Found } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function search() {
    if (terms.length < 2 || busy) return;
    setBusy("search"); setError("");
    try {
      const results = await searchOff(terms, undefined, { france: true });
      setFound({ terms, value: { results, ours: await ourProducts(results.map(item => item.code)) } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Recherche indisponible."); }
    finally { setBusy(null); }
  }
  async function open(code: string) {
    setBusy(code); setError("");
    try { navigate("/v2/produits/" + (await barcodeProduct(code)).id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Ouverture impossible."); setBusy(null); }
  }
  const shown = found && found.terms === terms ? found.value : null;
  return <section className="v2-off-search-catalogue" aria-labelledby="v2-off-search-heading">
    <div className="v2-off-search-catalogue-head">
      <h2 id="v2-off-search-heading">Chez Open Food Facts</h2>
      <button type="button" className="v2-button v2-button-secondary" disabled={terms.length < 2 || busy !== null} onClick={() => { void search(); }}>
        {busy === "search" ? "Recherche…" : terms.length >= 2 ? `Chercher « ${terms.slice(0, 40)} » chez Open Food Facts` : "Chercher aussi chez Open Food Facts"}</button>
    </div>
    <p className="v2-catalogue-source">Leur catalogue compte bien plus de produits. La recherche part de votre navigateur, seulement quand vous cliquez : votre adresse IP est transmise à Open Food Facts.</p>
    {error && <p role="alert">{error}</p>}
    {shown && (shown.results.length === 0 ? <p>Aucun produit vendu en France trouvé chez Open Food Facts.</p>
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
    {shown && shown.results.length > 0 && <p className="v2-catalogue-source">Résultats d’Open Food Facts (ODbL). « Ouvrir ici » crée une fiche ne contenant que le code-barres, pour l’ajouter au panier ou y noter un prix.</p>}
  </section>;
}
