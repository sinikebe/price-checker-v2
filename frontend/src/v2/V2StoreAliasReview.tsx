import { useEffect, useState, type FormEvent } from "react";
import { storeMatchesPath, storeRequest, type AliasProposal, type AliasSource,
  type StoreCandidate, type StoreMatches } from "./v2-stores-api";
import "./v2-store-alias.css";

const sourceLabels: Record<AliasSource, string> = {
  retailer: "Nom de l’enseigne / bookmarklet",
  open_food_facts: "Open Food Facts",
  open_prices: "Open Prices",
};

export default function V2StoreAliasReview() {
  const [pending, setPending] = useState<AliasProposal[] | null>(null);
  const [reload, setReload] = useState(0);
  const [retailer, setRetailer] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<AliasSource>("retailer");
  const [candidates, setCandidates] = useState<StoreCandidate[]>([]);
  const [selected, setSelected] = useState<StoreCandidate | null>(null);
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    storeRequest<AliasProposal[]>("/alias-proposals/pending")
      .then(rows => { if (active) setPending(rows); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [reload]);
  async function review(id: number, action: "approve" | "reject") {
    setBusy(true); setError(""); setNotice("");
    try {
      await storeRequest("/alias-proposals/" + id + "/review", "POST", { action });
      setReload(value => value + 1);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function search(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setSelected(null);
    try {
      const matches = await storeRequest<StoreMatches>(storeMatchesPath({
        retailer, store_name: query, city: "", postal_code: "",
      }, source));
      setCandidates(matches.matches);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await storeRequest<{ id: number | null; status: string }>(
        "/" + selected.id + "/alias-proposals", "POST", { name: alias, source });
      setNotice(result.status === "already_known" ? "Ce nom est déjà connu pour ce magasin."
        : "Nom proposé. Sa validation reste une action distincte.");
      setAlias(""); setReload(value => value + 1);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="v2-settings-card v2-store-alias-review" aria-labelledby="v2-store-alias-heading">
    <h2 id="v2-store-alias-heading">Noms supplémentaires des magasins</h2>
    <p>Ces noms servent à rapprocher les fiches des enseignes, d’Open Food Facts et d’Open Prices. Un nom proposé ne devient utilisable qu’après validation ici, indépendamment de la fiche produit et du prix.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <h3>Propositions en attente</h3>
    {!pending && !error && <p>Chargement…</p>}
    {pending?.length === 0 && <p>Aucun nom à valider.</p>}
    {pending?.map(item => <article key={item.id}>
      <p><strong>{item.name}</strong> · {sourceLabels[item.source]}</p>
      <p>Magasin visé : {item.retailer} · {item.store_name}{item.city && ` · ${item.city}`}{item.postal_code && ` · ${item.postal_code}`}
        <small> · proposé par {item.author}</small></p>
      <div className="v2-settings-actions">
        <button type="button" className="v2-button v2-button-primary" disabled={busy} onClick={() => void review(item.id, "approve")}>Valider le nom</button>
        <button type="button" className="v2-button v2-button-secondary" disabled={busy} onClick={() => void review(item.id, "reject")}>Refuser</button>
      </div>
    </article>)}
    <h3>Proposer un nom pour un magasin existant</h3>
    <form onSubmit={event => void search(event)} className="v2-store-alias-fields">
      <label>Enseigne<input required minLength={2} maxLength={200} value={retailer} onChange={event => { setRetailer(event.target.value); setCandidates([]); setSelected(null); }} /></label>
      <label>Nom actuel ou proche<input required minLength={2} maxLength={300} value={query} onChange={event => { setQuery(event.target.value); setCandidates([]); setSelected(null); }} /></label>
      <label>Origine du nom<select value={source} onChange={event => { setSource(event.target.value as AliasSource); setCandidates([]); setSelected(null); }}>
        {Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <button type="submit" className="v2-button v2-button-secondary" disabled={busy}>Chercher le magasin</button>
    </form>
    {candidates.length > 0 && <ul className="v2-store-alias-candidates">{candidates.map(candidate => <li key={candidate.id}>
      <button type="button" className="v2-button v2-button-secondary" aria-pressed={selected?.id === candidate.id}
        onClick={() => setSelected(candidate)}>{candidate.retailer} · {candidate.name}{candidate.city && ` · ${candidate.city}`}{candidate.postal_code && ` · ${candidate.postal_code}`}</button>
    </li>)}</ul>}
    {selected && <form onSubmit={event => void submit(event)} className="v2-store-alias-fields">
      <p>Magasin choisi : <strong>{selected.name}</strong></p>
      <label>Nom supplémentaire à proposer<input required minLength={2} maxLength={300} value={alias} onChange={event => setAlias(event.target.value)} /></label>
      <button type="submit" className="v2-button v2-button-primary" disabled={busy}>Proposer ce nom</button>
    </form>}
  </section>;
}
