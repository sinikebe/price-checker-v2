import { useEffect, useRef, useState } from "react";
import {
  ProductApiError, productRequest, type OffField, type OffSuggestion,
  type ProductData,
} from "./v2-products-api";

const proposals: { key: OffField; label: string; value: (suggestion: OffSuggestion) => string }[] = [
  { key: "name", label: "Nom", value: suggestion => suggestion.product_name?.trim() ?? "" },
  { key: "brand", label: "Marque", value: suggestion => suggestion.brand?.split(",")[0]?.trim() ?? "" },
  { key: "composition", label: "Composition", value: suggestion => suggestion.ingredients_text?.trim() ?? "" },
  { key: "quantity", label: "Quantité", value: suggestion => suggestion.quantity?.trim() ?? "" },
  { key: "ean", label: "Code EAN / GTIN", value: suggestion => suggestion.code?.trim() ?? "" },
  { key: "nutriscore", label: "Nutri-Score", value: suggestion => suggestion.nutriscore_grade?.toUpperCase() ?? "" },
  { key: "nova", label: "NOVA", value: suggestion => suggestion.nova_group?.toString() ?? "" },
];

function validCode(code: string | null): code is string {
  return Boolean(code && /^(?:[0-9]{8}|[0-9]{12,14})$/.test(code));
}

function safeImage(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "openfoodfacts.org" || parsed.hostname.endsWith(".openfoodfacts.org"))
      ? url : undefined;
  } catch { return undefined; }
}

export default function V2OffLookup({ data, onApply, disabled }: {
  data: ProductData;
  onApply: (next: ProductData) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState(data.name);
  const [searchTerm, setSearchTerm] = useState("");
  const [suggestions, setSuggestions] = useState<OffSuggestion[]>([]);
  const [selected, setSelected] = useState<OffSuggestion | null>(null);
  const [selectedFor, setSelectedFor] = useState("");
  const [checked, setChecked] = useState<OffField[]>([]);
  const currentEan = useRef(data.ean);
  currentEan.current = data.ean;
  const identity = [data.name, data.brand, data.quantity, data.ean].join("\u0000");
  const [searching, setSearching] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setQuery(data.name); }, [data.name]);
  useEffect(() => {
    if (selected && selectedFor !== identity) {
      setSelected(null); setChecked([]);
      setError("La référence a changé : choisissez à nouveau une fiche OFF.");
    }
  }, [identity, selected, selectedFor]);
  useEffect(() => {
    if (selected || disabled) return;
    const timer = window.setTimeout(() => {
      if (query.trim().length >= 2) setSearching(true);
      setSearchTerm(query.trim());
    }, 500);
    return () => window.clearTimeout(timer);
  }, [query, selected, disabled]);
  useEffect(() => {
    if (selected || disabled || searchTerm.length < 2) {
      setSuggestions([]);
      return;
    }
    let active = true;
    productRequest<{ suggestions: OffSuggestion[] }>("/off/search?q=" + encodeURIComponent(searchTerm))
      .then(result => { if (active) { setSuggestions(result.suggestions); setError(""); setSearching(false); } })
      .catch(reason => { if (active) { setSuggestions([]); setError(reason instanceof Error ? reason.message : "Recherche indisponible."); setSearching(false); } });
    return () => { active = false; };
  }, [searchTerm, selected, disabled]);
  // The spinner starts with the debounced request, not during local typing.
  function search(value: string) {
    setQuery(value); setSelected(null); setError(""); setSuggestions([]); setSearchTerm("");
    if (value.trim().length >= 2) setSearching(true);
  }
  async function lookupBarcode() {
    const barcode = data.ean.trim();
    if (!barcode || lookingUp) return;
    setLookingUp(true); setError(""); setSelected(null); setSuggestions([]);
    try {
      const result = await productRequest<OffSuggestion>("/off/product/" + encodeURIComponent(barcode));
      if (currentEan.current !== barcode) return;
      setSelected(result); setSelectedFor(identity); setChecked([]);
      setQuery(result.product_name ?? query);
    } catch (reason) {
      if (reason instanceof ProductApiError && reason.status === 404) {
        setError("Aucune fiche Open Food Facts pour ce code. Vous pouvez continuer la saisie manuellement.");
      } else {
        setError(reason instanceof Error ? reason.message : "Open Food Facts est indisponible.");
      }
    } finally { setLookingUp(false); }
  }
  function choose(suggestion: OffSuggestion) {
    setSelected(suggestion); setSelectedFor(identity); setChecked([]); setSuggestions([]); setError("");
  }
  function apply() {
    if (!selected || !validCode(selected.code) || checked.length === 0) return;
    const next = { ...data };
    for (const key of checked) {
      const proposal = proposals.find(item => item.key === key);
      if (proposal) next[key] = proposal.value(selected);
    }
    if (checked.includes("nutriscore")) next.nutriscore_version = selected.nutriscore_version ?? "";
    if (checked.includes("nutriscore") || checked.includes("nova")) next.nutrition_checked_at = new Date().toISOString();
    next.off_source = { code: selected.code, checked_at: new Date().toISOString(), fields: checked };
    onApply(next);
    setSelected(null); setChecked([]); setSuggestions([]);
  }
  const image = selected ? safeImage(selected.image_url) : undefined;
  return <section className="v2-workspace-card v2-off-card" aria-labelledby="v2-off-heading">
    <div className="v2-off-heading"><div><span className="v2-section-kicker">SOURCE EXTERNE</span>
      <h2 id="v2-off-heading">Open Food Facts</h2></div><span className="v2-off-mark">OFF ↗</span></div>
    <p>Recherchez une fiche par nom ou par code exact, puis choisissez les champs à reprendre. Rien n'est appliqué automatiquement.</p>
    <div className="v2-off-search">
      <label><span>Recherche par nom</span><input value={query} disabled={disabled}
        onChange={event => search(event.target.value)} placeholder="Nom du produit…" /></label>
      <button type="button" className="v2-button v2-button-secondary" disabled={disabled || !data.ean.trim() || lookingUp}
        onClick={() => { void lookupBarcode(); }}>{lookingUp ? "Recherche…" : "Chercher le code saisi"}</button>
    </div>
    {error && <p className="v2-off-error" role="alert">{error}</p>}
    {!selected && searchTerm.length >= 2 && <div className="v2-off-results" aria-live="polite">
      {searching ? <p>Recherche…</p> : suggestions.length ? suggestions.map((suggestion, index) =>
        <button key={suggestion.code ?? index} type="button" disabled={!validCode(suggestion.code)}
          onClick={() => choose(suggestion)}>
          {safeImage(suggestion.image_url) && <img src={safeImage(suggestion.image_url)} alt="" />}
          <span><strong>{suggestion.product_name || "Sans nom"}</strong><small>{suggestion.brand || "Marque inconnue"} · {suggestion.quantity || "Quantité inconnue"} · {suggestion.code || "Sans code"}</small></span>
          <span aria-hidden="true">→</span>
        </button>) : !error && <p>Aucun résultat trouvé.</p>}
    </div>}
    {selected && <div className="v2-off-preview">
      <div className="v2-off-selected"><div>{image && <img src={image} alt="" />}
        <div><strong>{selected.product_name || "Produit sans nom"}</strong><small>{selected.brand || "Marque inconnue"} · {selected.quantity || "Quantité inconnue"}</small>
          <a href={"https://world.openfoodfacts.org/product/" + selected.code} target="_blank" rel="noreferrer">Voir la fiche OFF ↗</a></div></div>
        <button type="button" onClick={() => { setSelected(null); setChecked([]); }}>Changer</button>
      </div>
      <h3>Champs à importer dans le brouillon</h3>
      <div className="v2-off-diff">{proposals.map(item => {
        const value = item.value(selected);
        if (!value) return null;
        const same = data[item.key].trim() === value;
        return <label key={item.key} className={same ? "v2-off-same" : ""}>
          <input type="checkbox" disabled={disabled || same} checked={checked.includes(item.key)}
            onChange={event => setChecked(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))} />
          <span><strong>{item.label}</strong><small>Actuel : {data[item.key] || "—"}</small><span>OFF : {value}</span>
            {item.key === "nutriscore" && selected.nutriscore_version && <small>Version {selected.nutriscore_version}</small>}</span>
        </label>;
      })}</div>
      <button type="button" className="v2-button v2-button-primary" disabled={disabled || checked.length === 0}
        onClick={apply}>Appliquer {checked.length ? checked.length + " champ" + (checked.length > 1 ? "s" : "") : "les champs choisis"}</button>
      <p className="v2-off-note">L'import remplit seulement le brouillon local. Vérifiez l'identité, la composition et le conditionnement avant de l'enregistrer sur le serveur.</p>
    </div>}
  </section>;
}
