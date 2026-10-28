import { useEffect, useState } from "react";
import { readOffInBrowser, type OffBrowserPreview } from "./off-browser-preview";
import type { OffField, OffSection } from "./off-types";
import type { V2User } from "./v2-auth-api";
import { ProductApiError, productRequest, type V2OffSnapshot } from "./v2-products-api";

function safeExternalUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : null;
  } catch { return null; }
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });
}
function fieldValue(field: OffField) {
  if (field.kind === "tags") return field.tags.join(" · ");
  if (field.kind === "number") return field.number?.toLocaleString("fr-FR") ?? "—";
  if (field.kind === "timestamp") return field.timestamp ? dateLabel(field.timestamp) : "—";
  if (field.kind === "json") return <pre>{JSON.stringify(field.json_value, null, 2)}</pre>;
  if (field.kind === "link" && field.url && safeExternalUrl(field.url)) {
    return <a href={field.url} target="_blank" rel="noreferrer">{field.url}</a>;
  }
  return field.text ?? "—";
}
function Section({ section }: { section: OffSection }) {
  const [open, setOpen] = useState(!section.collapsed);
  return <section className="v2-off-full-section">
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span aria-hidden="true">{open ? "▾" : "▸"}</span>{section.title}
    </button>
    {open && <div className="v2-off-full-body">
      {section.fields.length > 0 && <dl>{section.fields.map(field =>
        <div key={field.key}><dt title={field.key}>{field.label}</dt><dd>{fieldValue(field)}</dd></div>)}</dl>}
      {section.kind === "nutriments" && section.nutriments.length > 0 && <div className="v2-off-full-table-scroll"><table>
        <thead><tr><th>Nutriment</th><th>Pour 100 g/ml</th><th>Par portion</th></tr></thead>
        <tbody>{section.nutriments.map(row => <tr key={row.key}>
          <th>{row.label}</th><td>{row.modifier || ""} {row.per_100g?.toLocaleString("fr-FR") ?? "—"} {row.unit || ""}</td>
          <td>{row.per_serving?.toLocaleString("fr-FR") ?? "—"} {row.unit || ""}</td>
        </tr>)}</tbody>
      </table></div>}
      {section.kind === "images" && <div className="v2-off-full-images">{section.images.map(image =>
        <figure key={image.key}>{safeExternalUrl(image.url) &&
          <a href={image.url} target="_blank" rel="noreferrer">
            <img src={safeExternalUrl(image.thumb_url ?? "") ?? image.url}
              alt={image.label} loading="lazy" /></a>}
          <figcaption>{image.label}</figcaption></figure>)}</div>}
      {section.kind === "raw" && <pre className="v2-off-full-raw">{JSON.stringify(section.raw, null, 2)}</pre>}
    </div>}
  </section>;
}

export default function V2OffSnapshotPanel({ productId, ean, user }: {
  productId: number; ean: string; user: V2User | null;
}) {
  const [snapshot, setSnapshot] = useState<V2OffSnapshot | null>(null);
  const [sources, setSources] = useState<{ barcode: string; primary_source: boolean }[]>([]);
  const [selectedBarcode, setSelectedBarcode] = useState(ean);
  const [loading, setLoading] = useState(Boolean(ean));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [temporary, setTemporary] = useState<OffBrowserPreview | null>(null);
  useEffect(() => { setSelectedBarcode(ean); }, [productId, ean]);
  useEffect(() => {
    let active = true;
    productRequest<{ barcode: string; primary_source: boolean }[]>("/" + productId + "/off-sources")
      .then(value => {
        if (active) {
          setSources(value);
          if (value.length === 1 && (!ean || !value[0].primary_source)) setSelectedBarcode(value[0].barcode);
        }
      })
      .catch(() => { if (active) setSources([]); });
    return () => { active = false; };
  }, [productId, ean]);
  useEffect(() => {
    if (!selectedBarcode) return;
    let active = true;
    setLoading(true); setError(""); setSnapshot(null);
    const path = "/" + productId + "/off" + (selectedBarcode === ean ? "" :
      "?barcode=" + encodeURIComponent(selectedBarcode));
    productRequest<V2OffSnapshot>(path)
      .then(value => { if (active) { setSnapshot(value); setLoading(false); } })
      .catch(reason => {
        if (!active) return;
        if (!(reason instanceof ProductApiError && reason.status === 404))
          setError(reason instanceof Error ? reason.message : "Fiche Open Food Facts indisponible.");
        setLoading(false);
      });
    return () => { active = false; };
  }, [productId, ean, selectedBarcode]);
  const userId = user?.id;
  useEffect(() => {
    if (userId == null || !ean) { setPending(false); setTemporary(null); return; }
    let active = true;
    async function check() {
      try {
        const state = await productRequest<{ pending: boolean }>(`/${productId}/off/refresh-status`);
        if (!active) return;
        if (pending && !state.pending && selectedBarcode === ean) {
          void productRequest<V2OffSnapshot>(`/${productId}/off`)
            .then(value => { if (active) { setSnapshot(value); setTemporary(null); } }).catch(() => {});
        }
        setPending(state.pending);
      } catch { /* A status check must not erase a displayed sheet. */ }
    }
    void check();
    const timer = window.setInterval(() => { void check(); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [productId, ean, userId, pending, selectedBarcode]);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true); setError(""); setTemporary(null);
    try {
      const value = await productRequest<V2OffSnapshot>("/" + productId + "/off/refresh", "POST");
      setSnapshot(value);
    } catch (reason) {
      if (reason instanceof ProductApiError && reason.status === 429) {
        setPending(true);
        try {
          const preview = await readOffInBrowser(ean.trim());
          setTemporary(preview);
          setError(preview ? "Limite de consultation d’Open Food Facts atteinte. Une fiche provisoire est affichée ; sa mise à jour reste en attente." :
            "Limite de consultation d’Open Food Facts atteinte. Mise à jour en attente ; aucune fiche provisoire disponible.");
        } catch { setError("Limite de consultation d’Open Food Facts atteinte. La mise à jour reste en attente."); }
      } else {
        setError(reason instanceof Error ? reason.message : "Actualisation impossible.");
      }
    } finally { setRefreshing(false); }
  }
  return <section className="v2-workspace-card v2-off-full" aria-labelledby="v2-off-full-heading">
    <div className="v2-off-full-header"><div><span className="v2-section-kicker">SOURCE EXTERNE</span>
      <h2 id="v2-off-full-heading">Fiche Open Food Facts</h2></div>
      {user && ean && selectedBarcode === ean && <button type="button" className="v2-button v2-button-secondary" disabled={refreshing}
        onClick={() => { void refresh(); }}>{refreshing ? "Actualisation…" : snapshot ? "Actualiser la fiche" : "Récupérer la fiche"}</button>}
    </div>
    {!ean && sources.length === 0 ? <p>Ajoutez un code-barres pour consulter sa fiche Open Food Facts.</p> :
      <>
        <p>Ces données externes sont séparées du produit validé. Les actualiser ne modifie ni sa fiche ni son historique.</p>
        {sources.some(source => source.barcode !== ean) && <div aria-label="Fiches Open Food Facts associées">
          {sources.map(source => <button type="button" key={source.barcode}
            aria-pressed={selectedBarcode === source.barcode}
            onClick={() => setSelectedBarcode(source.barcode)}>
            {source.primary_source ? "Fiche principale" : "Ancien code fusionné"} · {source.barcode}
          </button>)}
        </div>}
        {loading && <p>Chargement de la fiche enregistrée…</p>}
        {!loading && !snapshot && !error && <p>{selectedBarcode ?
          "Aucune fiche Open Food Facts enregistrée pour ce code." : "Choisissez un ancien code fusionné."}</p>}
        {error && <p role="alert" className="v2-off-error">{error}</p>}
        {pending && <p role="status">La mise à jour depuis Open Food Facts est en attente. Cette fiche sera actualisée dès que possible.</p>}
        {temporary && <div className="v2-off-temporary">
          <strong>Lecture provisoire non enregistrée : {temporary.name || "Produit Open Food Facts"}</strong>
          <p>{temporary.brand || "Marque inconnue"} · {temporary.quantity || "Quantité inconnue"}</p>
          {temporary.ingredients && <p>Ingrédients : {temporary.ingredients}</p>}
          {temporary.nutriscore && <p>Nutri-Score : {temporary.nutriscore.toUpperCase()}</p>}
          <a href={`https://world.openfoodfacts.org/product/${temporary.code}`} target="_blank" rel="noreferrer">Voir chez Open Food Facts ↗</a>
        </div>}
        {snapshot && <>
          {snapshot.source_product_id !== undefined && snapshot.source_product_id !== productId &&
            <p>Fiche Open Food Facts d’un ancien code-barres conservée après la fusion du produit.</p>}
          <p>Récupérée le {dateLabel(snapshot.fetched_at)}
            {snapshot.off_last_modified && <> · Mise à jour chez Open Food Facts le {dateLabel(snapshot.off_last_modified)}</>}
            {snapshot.off_rev !== null && <> · Révision {snapshot.off_rev}</>}</p>
          <p>Informations issues d’Open Food Facts.{" "}
            <a href={snapshot.off_url} target="_blank" rel="noreferrer">Voir chez Open Food Facts ↗</a></p>
          <div className="v2-off-full-sections">{snapshot.sections.map(section =>
            <Section key={`${productId}:${section.id}`} section={section} />)}</div>
        </>}
      </>}
  </section>;
}
