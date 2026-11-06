import { useState } from "react";
import { OFF_PRODUCT_PAGE, OFF_UNAVAILABLE, readOffProduct, validBarcode, type OffProduct } from "./v2-off-browser";
import type { OffRead } from "./useOffProduct";
import { errorText } from "./v2-http";

const day = (value: string) => new Date(value).toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });
const amount = (value: number) => value.toLocaleString("fr-FR", { maximumFractionDigits: 2 });

/**
 * What Open Food Facts says about a product, read by this browser on request. Nothing reaches Open Food
 * Facts before the click, and nothing read here is kept by Price Checker.
 */
export default function V2OffPanel({ ean, initial }: { ean: string; initial?: OffProduct }) {
  const barcode = ean.trim();
  const [state, setState] = useState<OffRead>({ phase: "idle" });
  // Already read for this page (a product known only by its barcode): shown without a second request.
  const shown = state.phase === "idle" && initial ? { phase: "done" as const, product: initial } : state;
  async function read() {
    setState({ phase: "loading" });
    try {
      const product = await readOffProduct(barcode);
      setState(product ? { phase: "done", product } : { phase: "missing" });
    } catch (reason) {
      setState({ phase: "error", message: errorText(reason, OFF_UNAVAILABLE) });
    }
  }
  return <section className="v2-workspace-card v2-off-full" aria-labelledby="v2-off-heading">
    <div className="v2-off-full-header"><div><span className="v2-section-kicker">SOURCE EXTERNE</span>
      <h2 id="v2-off-heading">Open Food Facts</h2></div>
      {validBarcode(barcode) && shown.phase !== "done" && <button type="button" className="v2-button v2-button-secondary"
        disabled={shown.phase === "loading"} onClick={() => { void read(); }}>
        {shown.phase === "loading" ? "Lecture…" : "Afficher les informations d’Open Food Facts"}</button>}
    </div>
    {!validBarcode(barcode) ? <p>Ajoutez un code-barres au produit pour consulter Open Food Facts.</p>
      : shown.phase !== "done" && <p>Composition, Nutri-Score, groupe NOVA et valeurs nutritionnelles, lus directement par votre navigateur
        chez Open Food Facts : votre adresse IP leur est transmise, et Price Checker ne conserve rien de cette lecture.</p>}
    {shown.phase === "missing" && <p role="status">Ce code-barres n’est pas encore sur Open Food Facts.{" "}
      <a href={OFF_PRODUCT_PAGE + barcode} target="_blank" rel="noreferrer">L’y ajouter ↗</a></p>}
    {shown.phase === "error" && <p role="alert" className="v2-off-error">{shown.message}</p>}
    {shown.phase === "done" && <OffDetails product={shown.product} />}
  </section>;
}

/** What Open Food Facts says about a product, already read: image, scores, composition and nutrition. */
export function OffDetails({ product }: { product: OffProduct }) {
  return <div className="v2-off-browser">
    <div className="v2-off-selected"><div>{product.image && <img src={product.image} alt="" loading="lazy" />}
      <div><strong>{product.name || "Produit sans nom"}</strong>
        <small>{[product.brand, product.quantity].filter(Boolean).join(" · ") || "Marque et quantité non renseignées"}</small></div></div></div>
    <dl className="v2-workspace-facts">
      <div><dt>Nutri-Score</dt><dd>{product.nutriscore || "Non calculé"}</dd></div>
      <div><dt>Groupe NOVA</dt><dd>{product.nova || "Non calculé"}</dd></div>
    </dl>
    <h3>Composition</h3>
    <p>{product.ingredients || "Non renseignée sur Open Food Facts."}</p>
    {product.nutrition.length > 0 && <>
      <h3>Valeurs nutritionnelles pour 100 g ou 100 ml</h3>
      <div className="v2-off-full-table-scroll"><table><tbody>{product.nutrition.map(row =>
        <tr key={row.label}><th scope="row">{row.label}</th><td>{amount(row.value)} {row.unit}</td></tr>)}</tbody></table></div>
    </>}
    <p className="v2-off-note">Données <a href={OFF_PRODUCT_PAGE + product.code} target="_blank" rel="noreferrer">Open Food Facts ↗</a>,
      sous licence ODbL{product.modifiedAt ? `, mises à jour chez eux le ${day(product.modifiedAt)}` : ""}. Vérifiez sur l’emballage, notamment en cas d’allergie.</p>
  </div>;
}
