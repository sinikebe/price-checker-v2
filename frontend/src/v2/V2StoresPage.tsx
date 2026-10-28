import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { Frame } from "./V2ProductWorkspace";
import V2ReportControl from "./V2ReportControl";
import { storeRequest } from "./v2-stores-api";
import "./v2-stores-page.css";

type Store = {
  id: number; retailer: string; retailer_id: number; name: string;
  city: string | null; postal_code: string | null;
  supports_drive: boolean; supports_delivery: boolean;
  external_store_id?: string | null; osm_type?: string | null; osm_id?: number | null;
  aliases?: { source: string; name: string }[]; merged_to_id?: number | null;
};
const sourceName: Record<string,string> = { retailer: "Enseigne", open_food_facts: "Open Food Facts", open_prices: "Open Prices" };

export default function V2StoresPage({ id, user, onLogout }: {
  id?: number; user: V2User | null; onLogout: () => Promise<void>;
}) {
  const [stores, setStores] = useState<Store[] | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    let active = true;
    const task = id ? storeRequest<Store>("/" + id).then(value => { if (active) setStore(value); })
      : storeRequest<Store[]>("").then(value => { if (active) setStores(value); });
    task.catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [id]);
  const groups = useMemo(() => {
    const result = new Map<string, Store[]>();
    for (const item of stores ?? []) {
      if (query && ![item.retailer,item.name,item.city ?? "",item.postal_code ?? ""]
        .join(" ").toLocaleLowerCase("fr").includes(query.toLocaleLowerCase("fr"))) continue;
      result.set(item.retailer, [...(result.get(item.retailer) ?? []), item]);
    }
    return [...result];
  }, [stores,query]);
  if (id && store?.id === id && store.merged_to_id) return <Navigate to={"/v2/magasins/" + store.merged_to_id} replace />;
  return <Frame user={user} onLogout={onLogout}>
    {id ? <>
      <Link to="/v2/magasins">← Tous les magasins</Link>
      {error && <p role="alert">{error}</p>}
      {!store && !error && <p>Chargement…</p>}
      {store && store.id === id && <><div className="v2-workspace-heading"><div><span className="v2-section-kicker">MAGASIN · {store.retailer}</span>
        <h1>{store.name}<span>.</span></h1><p>{store.postal_code} {store.city}</p></div></div>
        {store.merged_to_id ? <section className="v2-workspace-card"><h2>Fiche fusionnée</h2>
          <p>Ce magasin a été regroupé avec <Link to={"/v2/magasins/" + store.merged_to_id}>la fiche actuelle</Link>.</p></section> : <>
          <section className="v2-workspace-card"><h2>Informations</h2>
            <dl className="v2-workspace-facts">
              <div><dt>Enseigne</dt><dd>{store.retailer}</dd></div>
              <div><dt>Ville</dt><dd>{store.city || "À compléter"}</dd></div>
              <div><dt>Code postal</dt><dd>{store.postal_code || "À compléter"}</dd></div>
              <div><dt>Services</dt><dd>{[store.supports_drive && "Drive",store.supports_delivery && "Livraison"].filter(Boolean).join(" · ") || "Non précisés"}</dd></div>
              {store.aliases && store.aliases.length > 0 && <div><dt>Autres noms validés</dt><dd>{store.aliases.map(alias => `${alias.name} (${sourceName[alias.source] ?? alias.source})`).join(" · ")}</dd></div>}
            </dl></section>
          <V2ReportControl kind="store" contentId={store.id} user={user} />
        </>}
      </>}
    </> : <><div className="v2-workspace-heading"><div><span className="v2-section-kicker">ANNUAIRE PUBLIC · V2</span>
      <h1>Magasins<span>.</span></h1><p>Points de vente regroupés par enseigne.</p></div></div>
      <label className="v2-stores-search" htmlFor="v2-store-search">Rechercher un magasin
        <input id="v2-store-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="Enseigne, magasin, ville ou code postal" /></label>
      {error && <p role="alert">{error}</p>}
      {!stores && !error && <p>Chargement…</p>}
      {stores && groups.length === 0 && <p>Aucun magasin trouvé.</p>}
      {groups.map(([retailer,items]) => <section key={retailer} className="v2-workspace-card v2-stores-group">
        <h2>{retailer} <small>({items.length})</small></h2><ul>{items.map(item => <li key={item.id}>
          <Link to={"/v2/magasins/" + item.id}>{item.name}</Link>
          <span>{item.postal_code} {item.city || "Ville à compléter"}</span>
        </li>)}</ul>
      </section>)}
    </>}
  </Frame>;
}
