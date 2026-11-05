import { useEffect, useRef, useState } from "react";
import { OFF_PRODUCT_PAGE, readOffProduct, searchOff, validBarcode, type OffMatch } from "./v2-off-browser";
import type { OffField, ProductData } from "./v2-products-api";

/** The identifying facts a contributor may copy from Open Food Facts; the rest stays there. */
const proposals: { key: OffField; label: string; value: (match: OffMatch) => string }[] = [
  { key: "name", label: "Nom", value: match => match.name },
  { key: "brand", label: "Marque", value: match => match.brand },
  { key: "quantity", label: "Quantité", value: match => match.quantity },
  { key: "ean", label: "Code EAN / GTIN", value: match => match.code },
];

/**
 * Helps a contributor fill a product from Open Food Facts, read by this browser on request (a search or
 * a barcode lookup per click). Only the facts the contributor ticks are copied into the draft.
 */
export default function V2OffLookup({ data, onApply, disabled }: {
  data: ProductData;
  onApply: (next: ProductData) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState(data.name);
  const [results, setResults] = useState<OffMatch[] | null>(null);
  const [selected, setSelected] = useState<OffMatch | null>(null);
  const [selectedFor, setSelectedFor] = useState("");
  const [checked, setChecked] = useState<OffField[]>([]);
  const [busy, setBusy] = useState<"search" | "barcode" | null>(null);
  const [error, setError] = useState("");
  const currentEan = useRef(data.ean);
  useEffect(() => { currentEan.current = data.ean; }, [data.ean]);
  const identity = [data.name, data.brand, data.quantity, data.ean].join("\u0000");

  useEffect(() => { setQuery(data.name); }, [data.name]);
  useEffect(() => {
    if (selected && selectedFor !== identity) {
      setSelected(null); setChecked([]);
      setError("La référence a changé : choisissez à nouveau une fiche Open Food Facts.");
    }
  }, [identity, selected, selectedFor]);

  function choose(match: OffMatch) {
    setSelected(match); setSelectedFor(identity); setChecked([]); setResults(null); setError("");
  }
  async function search() {
    const terms = query.trim();
    if (terms.length < 2 || busy) return;
    setBusy("search"); setError(""); setSelected(null); setResults(null);
    try { setResults(await searchOff(terms)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Recherche indisponible."); }
    finally { setBusy(null); }
  }
  async function lookupBarcode() {
    const barcode = data.ean.trim();
    if (!validBarcode(barcode) || busy) return;
    setBusy("barcode"); setError(""); setSelected(null); setResults(null);
    try {
      const product = await readOffProduct(barcode);
      if (currentEan.current.trim() !== barcode) return;
      if (product) choose(product);
      else setError("Produit introuvable sur Open Food Facts. Vous pouvez continuer la saisie manuellement.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Open Food Facts ne répond pas pour le moment."); }
    finally { setBusy(null); }
  }
  function apply() {
    if (!selected || checked.length === 0) return;
    const next = { ...data };
    for (const key of checked) {
      const proposal = proposals.find(item => item.key === key);
      if (proposal) next[key] = proposal.value(selected);
    }
    // Facts copied earlier from the same sheet stay recorded with the new ones.
    const earlier = data.off_source?.code === selected.code ? data.off_source.fields : [];
    next.off_source = { code: selected.code, checked_at: new Date().toISOString(), fields: [...new Set([...earlier, ...checked])] };
    onApply(next);
    setSelected(null); setChecked([]);
  }
  return <section className="v2-workspace-card v2-off-card" aria-labelledby="v2-off-lookup-heading">
    <div className="v2-off-heading"><div><span className="v2-section-kicker">SOURCE EXTERNE</span>
      <h2 id="v2-off-lookup-heading">Open Food Facts</h2></div><span className="v2-off-mark">OFF ↗</span></div>
    <p>Retrouvez le produit chez Open Food Facts pour reprendre son nom, sa marque, sa quantité ou son code-barres.
      La recherche part de votre navigateur : votre adresse IP est transmise à Open Food Facts.</p>
    {/* Inside the product form: no nested form, Enter searches instead of saving the draft. */}
    <div className="v2-off-search">
      <label><span>Recherche par nom</span><input value={query} disabled={disabled}
        onChange={event => setQuery(event.target.value)} placeholder="Nom du produit…"
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void search(); } }} /></label>
      <button type="button" className="v2-button v2-button-secondary" disabled={disabled || query.trim().length < 2 || busy !== null}
        onClick={() => { void search(); }}>
        {busy === "search" ? "Recherche…" : "Chercher"}</button>
      <button type="button" className="v2-button v2-button-secondary" disabled={disabled || !validBarcode(data.ean.trim()) || busy !== null}
        onClick={() => { void lookupBarcode(); }}>{busy === "barcode" ? "Recherche…" : "Chercher le code saisi"}</button>
    </div>
    {error && <p className="v2-off-error" role="alert">{error}</p>}
    {results && <div className="v2-off-results" aria-live="polite">
      {results.length ? results.map(match =>
        <button key={match.code} type="button" onClick={() => choose(match)}>
          {match.image && <img src={match.image} alt="" loading="lazy" />}
          <span><strong>{match.name || "Sans nom"}</strong><small>{match.brand || "Marque inconnue"} · {match.quantity || "Quantité inconnue"} · {match.code}</small></span>
          <span aria-hidden="true">→</span>
        </button>) : <p>Aucun résultat trouvé.</p>}
    </div>}
    {selected && <div className="v2-off-preview">
      <div className="v2-off-selected"><div>{selected.image && <img src={selected.image} alt="" />}
        <div><strong>{selected.name || "Produit sans nom"}</strong><small>{selected.brand || "Marque inconnue"} · {selected.quantity || "Quantité inconnue"}</small>
          <a href={OFF_PRODUCT_PAGE + selected.code} target="_blank" rel="noreferrer">Voir la fiche Open Food Facts ↗</a></div></div>
        <button type="button" onClick={() => { setSelected(null); setChecked([]); }}>Changer</button>
      </div>
      <h3>Informations à reprendre dans le brouillon</h3>
      <div className="v2-off-diff">{proposals.map(item => {
        const value = item.value(selected);
        if (!value) return null;
        const same = data[item.key].trim() === value;
        return <label key={item.key} className={same ? "v2-off-same" : ""}>
          <input type="checkbox" disabled={disabled || same} checked={checked.includes(item.key)}
            onChange={event => setChecked(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))} />
          <span><strong>{item.label}</strong><small>Actuel : {data[item.key] || "—"}</small><span>Open Food Facts : {value}</span></span>
        </label>;
      })}</div>
      <button type="button" className="v2-button v2-button-primary" disabled={disabled || checked.length === 0}
        onClick={apply}>Reprendre {checked.length ? checked.length + " information" + (checked.length > 1 ? "s" : "") : "les informations choisies"}</button>
      <p className="v2-off-note">Seul le brouillon local change. La composition, le Nutri-Score et le groupe NOVA restent chez Open Food Facts :
        la fiche publiée les affiche à la demande.</p>
    </div>}
  </section>;
}
