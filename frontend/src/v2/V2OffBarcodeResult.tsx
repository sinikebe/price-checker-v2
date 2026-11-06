import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAppMode } from "./useAppMode";
import { useOffProduct } from "./useOffProduct";
import { barcodeProduct } from "./v2-barcode";
import { OFF_PRODUCT_PAGE } from "./v2-off-browser";
import { errorText } from "./v2-http";

/**
 * A barcode our catalogue does not know: what Open Food Facts says about it (read by this browser),
 * and the way to use it here. Opening it creates our product for this barcode, holding only the barcode.
 */
export default function V2OffBarcodeResult({ code }: { code: string }) {
  const navigate = useNavigate();
  const { mode, canSwitch: signedIn } = useAppMode();
  const read = useOffProduct(code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    setBusy(true); setError("");
    try { navigate("/v2/produits/" + (await barcodeProduct(code)).id); }
    catch (reason) { setError(errorText(reason, "Ajout impossible. Réessayez.")); setBusy(false); }
  }
  const propose = mode === "contribute" && <Link className="v2-button v2-button-secondary" to={"/v2/produits/nouveau?ean=" + encodeURIComponent(code)}>Proposer une fiche complète</Link>;
  return <section className="v2-off-barcode" aria-live="polite" aria-label="Résultat chez Open Food Facts">
    <p className="v2-off-barcode-lead">Ce code-barres n’est pas encore dans notre catalogue.</p>
    {read.phase === "loading" && <p>Lecture chez Open Food Facts…</p>}
    {read.phase === "error" && <p role="alert">{read.message}</p>}
    {read.phase === "missing" && <>
      <p>Open Food Facts ne le connaît pas non plus. <a href={OFF_PRODUCT_PAGE + code} target="_blank" rel="noreferrer">L’y ajouter ↗</a></p>
      {propose && <div className="v2-recipes-actions">{propose}</div>}
    </>}
    {read.phase === "done" && <>
      <div className="v2-off-selected"><div>{read.product.image && <img src={read.product.image} alt="" />}
        <div><strong>{read.product.name || "Produit sans nom"}</strong>
          <small>{[read.product.brand, read.product.quantity].filter(Boolean).join(" · ") || code}</small>
          <small>Lu chez <a href={OFF_PRODUCT_PAGE + code} target="_blank" rel="noreferrer">Open Food Facts ↗</a> (ODbL) par votre navigateur.</small></div></div></div>
      <div className="v2-recipes-actions">
        {signedIn ? <button type="button" className="v2-button v2-button-primary" disabled={busy} onClick={() => { void open(); }}>
          {busy ? "Ouverture…" : "Ouvrir sa fiche pour l’ajouter au panier ou noter un prix"}</button>
          : <Link className="v2-button v2-button-primary" to="/v2/connexion">Se connecter pour l’ajouter au panier ou noter un prix</Link>}
        {propose}
      </div>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
