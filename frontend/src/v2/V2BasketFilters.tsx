import { Link } from "react-router-dom";
import { useSiteFilter } from "./useSiteFilter";
import { emptyBasketFilters, type BasketFilters } from "./v2-basket-comparison";
import { siteFilterSummary } from "./v2-site-filter";

function MultiFilter<T extends string | number>({ title, options, selected, onChange, label }: {
  title: string; options: T[]; selected: T[]; onChange: (next: T[]) => void; label: (value: T) => string;
}) {
  return <details className="v2-basket-filter"><summary>{title}{selected.length ? ` · ${selected.length}` : " · Tous"}</summary>
    <div className="v2-basket-filter-options">{options.length ? options.map(value => <label key={value}>
      <input type="checkbox" checked={selected.includes(value)} onChange={event => onChange(event.target.checked
        ? [...selected, value] : selected.filter(item => item !== value))} />{label(value)}</label>) : <p>Aucune option disponible.</p>}</div>
  </details>;
}

export type DefaultStores = {
  count: number; matches: boolean; unavailable: string[]; error: boolean;
  save: () => void; restore: () => void; remove: () => void;
};

/** Which stores are compared. The filters narrow the prices already fetched: no credit is spent. */
export default function V2BasketFilters({ filters, onChange, storeOptions, storeLabel, cityOptions, departmentOptions, defaults, siteFilter = true }: {
  filters: BasketFilters; onChange: (next: BasketFilters) => void;
  storeOptions: number[]; storeLabel: (id: number) => string;
  cityOptions: string[]; departmentOptions: string[];
  /** The stores chosen by default in this browser; absent in the demo basket, which changes nothing outside its tab. */
  defaults?: DefaultStores;
  /** Whether the account's site-wide filter applies here (not in the demo basket). */
  siteFilter?: boolean;
}) {
  const site = useSiteFilter();
  if (siteFilter && site.active) return <section className="v2-basket-panel" id="v2-basket-panel-filters" aria-label="Filtrer les magasins comparés">
    <p role="status"><strong>Le filtre de magasins du site est actif</strong> ({siteFilterSummary(site.filter)}) : il remplace les filtres de ce panier.{" "}
      <Link to="/v2/parametres/compte">Le modifier dans les paramètres du compte</Link>.</p>
  </section>;
  const active = filters.storeIds.length + filters.cities.length + filters.departments.length > 0;
  return <section className="v2-basket-panel" id="v2-basket-panel-filters" aria-label="Filtrer les magasins comparés">
    <p>Filtrez les magasins déjà récupérés, sans dépenser de crédit. Les filtres se cumulent.</p>
    <div className="v2-basket-filter-grid">
      <MultiFilter title="Magasins" options={storeOptions} selected={filters.storeIds} onChange={storeIds => onChange({ ...filters, storeIds })} label={storeLabel} />
      <MultiFilter title="Communes" options={cityOptions} selected={filters.cities} onChange={cities => onChange({ ...filters, cities })} label={city => city} />
      <MultiFilter title="Départements" options={departmentOptions} selected={filters.departments} onChange={departments => onChange({ ...filters, departments })} label={department => department} />
    </div>
    {defaults ? <div className="v2-basket-default-stores">
      <p>{defaults.count ? `${defaults.count} magasin${defaults.count > 1 ? "s" : ""} par défaut sur ce navigateur.` : "Aucun magasin par défaut sur ce navigateur."}</p>
      <div className="v2-basket-default-actions">
        {filters.storeIds.length > 0 && !defaults.matches && <button type="button" className="v2-button v2-button-secondary" onClick={defaults.save}>Choisir ces magasins par défaut</button>}
        {defaults.count > 0 && !defaults.matches && <button type="button" className="v2-button v2-button-secondary" onClick={defaults.restore}>Revenir aux magasins par défaut</button>}
        {defaults.count > 0 && <button type="button" className="v2-button v2-button-secondary" onClick={defaults.remove}>Oublier les magasins par défaut</button>}
        {active && <button type="button" className="v2-button v2-button-secondary" onClick={() => onChange(emptyBasketFilters)}>Effacer les filtres</button>}
      </div>
      {defaults.unavailable.length > 0 && <p>Sans prix pour ce panier : {defaults.unavailable.join(", ")}.</p>}
      {defaults.error && <p role="alert">Impossible d’enregistrer ce choix dans le navigateur.</p>}
    </div> : active && <div className="v2-basket-default-actions">
      <button type="button" className="v2-button v2-button-secondary" onClick={() => onChange(emptyBasketFilters)}>Effacer les filtres</button></div>}
  </section>;
}
