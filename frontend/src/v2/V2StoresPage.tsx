import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { Frame } from "./V2ProductWorkspace";
import V2ReportControl from "./V2ReportControl";
import V2RetailerGroupsAdmin from "./V2RetailerGroupsAdmin";
import { storeRequest } from "./v2-stores-api";
import "./v2-stores-page.css";

type Store = {
  id: number; retailer: string; retailer_id: number; retailer_group: string; retailer_group_id: number; name: string;
  city: string | null; postal_code: string | null;
  supports_drive: boolean; supports_delivery: boolean; active: boolean;
  external_store_id?: string | null; osm_type?: string | null; osm_id?: number | null;
  aliases?: { source: string; name: string }[]; merged_to_id?: number | null;
  impact?: { prices: number; drafts: number; offers: number };
};
const sourceName: Record<string,string> = { retailer: "Enseigne", open_food_facts: "Open Food Facts", open_prices: "Open Prices" };

export default function V2StoresPage({ id, user, onLogout }: {
  id?: number; user: V2User | null; onLogout: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [actionError, setActionError] = useState("");
  async function changeActivity(active: boolean) {
    if (!store || busy) return;
    setBusy(true); setActionError("");
    try {
      await storeRequest("/" + store.id + "/activity", "PUT", { active });
      setReload(value => value + 1);
    } catch (cause) { setActionError(String(cause)); }
    finally { setBusy(false); }
  }
  async function removeStore(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!store || busy || confirmation !== store.name) return;
    setBusy(true); setActionError("");
    try {
      await storeRequest("/" + store.id + "/delete", "POST", { confirmation });
      navigate("/v2/magasins", { replace: true });
    } catch (cause) { setActionError(String(cause)); setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    const task = id ? storeRequest<Store>("/" + id).then(value => { if (active) setStore(value); })
      : storeRequest<Store[]>("").then(value => { if (active) setStores(value); });
    task.catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [id,reload]);
  const groups = useMemo(() => {
    const result = new Map<number, { name: string; items: Store[] }>();
    for (const item of stores ?? []) {
      if (query && ![item.retailer_group,item.retailer,item.name,item.city ?? "",item.postal_code ?? ""]
        .join(" ").toLocaleLowerCase("fr").includes(query.toLocaleLowerCase("fr"))) continue;
      const group = result.get(item.retailer_group_id) ?? { name: item.retailer_group, items: [] };
      group.items.push(item);
      result.set(item.retailer_group_id, group);
    }
    return [...result];
  }, [stores,query]);
  if (id && store?.id === id && store.merged_to_id) return <Navigate to={"/v2/magasins/" + store.merged_to_id} replace />;
  return <Frame user={user} onLogout={onLogout}>
    {id ? <>
      <Link to="/v2/magasins">← Tous les magasins</Link>
      {error && <p role="alert">{error}</p>}
      {!store && !error && <p>Chargement…</p>}
      {store && store.id === id && <><div className="v2-workspace-heading"><div><span className="v2-section-kicker">MAGASIN · {store.retailer_group}</span>
        <h1>{store.name}<span>.</span></h1><p>{store.postal_code} {store.city}</p></div></div>
        {store.merged_to_id ? <section className="v2-workspace-card"><h2>Fiche fusionnée</h2>
          <p>Ce magasin a été regroupé avec <Link to={"/v2/magasins/" + store.merged_to_id}>la fiche actuelle</Link>.</p></section> : <>
          <section className="v2-workspace-card"><h2>Informations</h2>
            <dl className="v2-workspace-facts">
              <div><dt>Groupe d’enseignes</dt><dd>{store.retailer_group}</dd></div>
              <div><dt>Enseigne d’origine</dt><dd>{store.retailer}</dd></div>
              <div><dt>Ville</dt><dd>{store.city || "À compléter"}</dd></div>
              <div><dt>Code postal</dt><dd>{store.postal_code || "À compléter"}</dd></div>
              <div><dt>Services</dt><dd>{[store.supports_drive && "Drive",store.supports_delivery && "Livraison"].filter(Boolean).join(" · ") || "Non précisés"}</dd></div>
              {user?.role === "admin" && <div><dt>Statut</dt><dd>{store.active ? "Actif" : "Désactivé · masqué au public"}</dd></div>}
              {store.aliases && store.aliases.length > 0 && <div><dt>Autres noms validés</dt><dd>{store.aliases.map(alias => `${alias.name} (${sourceName[alias.source] ?? alias.source})`).join(" · ")}</dd></div>}
            </dl></section>
          {user?.role === "admin" && <section className="v2-workspace-card v2-store-management">
            <h2>Gestion du magasin</h2>
            <p>La désactivation est temporaire : elle masque la fiche, ses prix et ses résultats de panier. Les données restent conservées et peuvent être réactivées.</p>
            <button type="button" className="v2-button v2-button-secondary" disabled={busy}
              onClick={() => void changeActivity(!store.active)}>{store.active ? "Désactiver le magasin" : "Réactiver le magasin"}</button>
            <form onSubmit={event => void removeStore(event)}>
              <h3>Supprimer définitivement</h3>
              <p>Cette action efface le magasin et tous ses prix associés, ainsi que les brouillons et offres sources. Elle ne peut pas être annulée.</p>
              {store.impact && <p>Éléments concernés : {store.impact.prices} prix publiés, {store.impact.drafts} brouillons et {store.impact.offers} offres sources.</p>}
              <label>Saisissez exactement « {store.name} » pour confirmer
                <input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /></label>
              <button type="submit" className="v2-button v2-button-secondary" disabled={busy || confirmation !== store.name}>Supprimer le magasin et ses prix</button>
            </form>
            {actionError && <p role="alert">{actionError}</p>}
          </section>}
          <V2ReportControl kind="store" contentId={store.id} user={user} />
        </>}
      </>}
    </> : <><div className="v2-workspace-heading"><div><span className="v2-section-kicker">POINTS DE VENTE</span>
      <h1>Magasins<span>.</span></h1><p>Les magasins sont regroupés par enseigne. Le nom d’enseigne relevé à l’origine reste indiqué lorsqu’il diffère.</p></div></div>
      <label className="v2-stores-search" htmlFor="v2-store-search">Rechercher un magasin
        <input id="v2-store-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="Enseigne, magasin, ville ou code postal" /></label>
      {error && <p role="alert">{error}</p>}
      {user?.role === "admin" && <V2RetailerGroupsAdmin onChanged={() => setReload(value => value + 1)} />}
      {!stores && !error && <p>Chargement…</p>}
      {stores && groups.length === 0 && <p>Aucun magasin trouvé.</p>}
      {groups.map(([groupId,group]) => <section key={groupId} className="v2-workspace-card v2-stores-group">
        <h2>{group.name} <small>({group.items.length})</small></h2><ul>{group.items.map(item => <li key={item.id}>
          <span><Link to={"/v2/magasins/" + item.id}>{item.name}</Link>
            {!item.active && <small className="v2-stores-inactive"> · Désactivé</small>}
            {item.retailer !== group.name && <small className="v2-stores-source"> · {item.retailer}</small>}</span>
          <span>{item.postal_code} {item.city || "Ville à compléter"}</span>
        </li>)}</ul>
      </section>)}
    </>}
  </Frame>;
}
