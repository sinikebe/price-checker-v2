import { useEffect, useMemo, useState } from "react";
import { useSiteFilter } from "./useSiteFilter";
import { postalDepartment } from "./v2-basket-comparison";
import { directoryStoreLabel as storeLabel, siteFilterSummary, type DirectoryStore, type SiteFilter, type SiteFilterStore } from "./v2-site-filter";
import { errorText } from "./v2-http";

const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");
const same = (left: SiteFilter, right: SiteFilter) => JSON.stringify(left) === JSON.stringify(right);

function Choices<T extends string | number>({ title, options, selected, label, onChange, search }: {
  title: string; options: T[]; selected: T[]; label: (value: T) => string; onChange: (next: T[]) => void; search?: boolean;
}) {
  const [query, setQuery] = useState("");
  const shown = search && query.trim() ? options.filter(value => fold(label(value)).includes(fold(query.trim()))) : options;
  return <details className="v2-site-filter-choices">
    <summary>{title} · {selected.length ? selected.length : "tous"}</summary>
    {search && <label className="v2-site-filter-search">Chercher<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    <div className="v2-site-filter-options">{shown.length ? shown.map(value => <label key={value}>
      <input type="checkbox" checked={selected.includes(value)}
        onChange={event => onChange(event.target.checked ? [...selected, value] : selected.filter(item => item !== value))} />{label(value)}</label>)
      : <p>Aucune option.</p>}</div>
  </details>;
}

/**
 * Account setting: one store filter for the whole site. On, every price shown (products, groups,
 * baskets, lists) is limited to these stores, communes and departments; the basket filters give way.
 * Saved on this device; saving it to the account comes later.
 */
export default function V2SiteFilterSettings() {
  const { filter: saved, save, signedIn } = useSiteFilter();
  const [draft, setDraft] = useState<SiteFilter>(saved);
  // Switched on or off elsewhere (the profile menu, another tab): an untouched draft follows.
  const [base, setBase] = useState(saved);
  if (saved !== base) { setBase(saved); if (same(draft, base)) setDraft(saved); }
  const [directory, setDirectory] = useState<DirectoryStore[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/v2/stores", { credentials: "same-origin" })
      .then(response => response.ok ? response.json() as Promise<DirectoryStore[]> : Promise.reject(new Error()))
      .then(stores => { if (active) setDirectory(stores); })
      .catch(() => { if (active) setError("La liste des magasins n’a pas pu être chargée."); });
    return () => { active = false; };
  }, []);
  const byId = useMemo(() => new Map((directory ?? []).map(store => [store.id, store])), [directory]);
  const departments = useMemo(() => [...new Set((directory ?? []).map(store => postalDepartment(store.postal_code)).filter((code): code is string => !!code))]
    .sort((a, b) => a.localeCompare(b, "fr")), [directory]);
  const cities = useMemo(() => [...new Set((directory ?? []).map(store => store.city?.trim()).filter((city): city is string => !!city))]
    .sort((a, b) => a.localeCompare(b, "fr")), [directory]);
  const storeIds = useMemo(() => (directory ?? []).slice().sort((a, b) => storeLabel(a).localeCompare(storeLabel(b), "fr")).map(store => store.id), [directory]);
  const labels = new Map<number, string>(draft.stores.map(store => [store.id, store.label]));
  const labelOf = (id: number) => byId.has(id) ? storeLabel(byId.get(id)!) : labels.get(id) ?? `Magasin ${id}`;
  const changed = !same(draft, saved);
  if (!signedIn) return null;

  function setStores(ids: number[]) {
    setDraft({ ...draft, stores: ids.map((id): SiteFilterStore => ({ id, label: labelOf(id) })) }); setNotice("");
  }
  function keep() {
    setError(""); setNotice("");
    try { save(draft); setNotice(draft.enabled ? "Filtre enregistré sur cet appareil : il s’applique à tout le site." : "Filtre enregistré sur cet appareil, désactivé."); }
    catch (reason) { setError(errorText(reason, "Enregistrement impossible sur cet appareil.")); }
  }
  return <section className="v2-settings-card v2-site-filter" aria-labelledby="v2-site-filter-heading">
    <h2 id="v2-site-filter-heading">Filtre de magasins pour tout le site</h2>
    <p>Activé, il limite tous les prix affichés (fiches produits, groupes, ensembles, paniers et listes de courses) aux magasins, communes et départements choisis. Les filtres des paniers sont alors remplacés par celui-ci. Le panier de démonstration n’est pas concerné.</p>
    <label className="v2-site-filter-switch"><input type="checkbox" checked={draft.enabled}
      onChange={event => { setDraft({ ...draft, enabled: event.target.checked }); setNotice(""); }} />Activer le filtre sur tout le site</label>
    {directory === null && !error ? <p>Chargement des magasins…</p> : <div className="v2-site-filter-grid">
      <Choices title="Départements" options={departments} selected={draft.departments} label={code => code}
        onChange={next => { setDraft({ ...draft, departments: next }); setNotice(""); }} />
      <Choices title="Communes" options={cities} selected={draft.cities} label={city => city} search
        onChange={next => { setDraft({ ...draft, cities: next }); setNotice(""); }} />
      <Choices title="Magasins" options={[...new Set([...storeIds, ...draft.stores.map(store => store.id)])]} selected={draft.stores.map(store => store.id)}
        label={labelOf} search onChange={setStores} />
    </div>}
    <p className="v2-settings-note">Choix actuel : {siteFilterSummary(draft)}. Les critères se cumulent ; les plateformes en ligne passent les filtres de commune et de département.</p>
    <div className="v2-settings-actions">
      <button type="button" className="v2-button v2-button-primary" disabled={!changed} onClick={keep}>Enregistrer sur cet appareil</button>
      <button type="button" className="v2-button v2-button-secondary" disabled aria-describedby="v2-site-filter-cloud">Enregistrer dans le cloud</button>
      <small id="v2-site-filter-cloud" className="v2-site-filter-soon">Bientôt disponible : retrouver ce filtre sur tous vos appareils.</small>
    </div>
    {saved.enabled && !changed && !notice && <p className="v2-schedule-success" role="status">Filtre actif sur tout le site ({siteFilterSummary(saved)}).</p>}
    {notice && <p className="v2-schedule-success" role="status">{notice}</p>}
    {error && <p className="v2-schedule-error" role="alert">{error}</p>}
  </section>;
}
