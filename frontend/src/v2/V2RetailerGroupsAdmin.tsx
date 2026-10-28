import { useEffect, useState } from "react";
import { storeRequest } from "./v2-stores-api";

type Retailer = { id: number; name: string; group_id: number; store_count: number };
type Group = { id: number; name: string; retailers: Retailer[] };

export default function V2RetailerGroupsAdmin({ onChanged }: { onChanged: () => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    storeRequest<Group[]>("/retailer-groups")
      .then(value => { if (active) { setGroups(value); setError(""); } })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [reload]);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await storeRequest("/retailer-groups", "POST", { name });
      setName(""); setReload(value => value + 1);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function assign(retailerId: number, groupId: number) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await storeRequest("/retailers/" + retailerId + "/group", "PUT", { group_id: groupId });
      setReload(value => value + 1);
      onChanged();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <details className="v2-workspace-card v2-retailer-groups-admin">
    <summary>Gérer les groupes d’enseignes</summary>
    <p>Ces groupes organisent l’annuaire. Les noms d’enseigne d’origine restent attachés aux magasins et aux relevés de prix.</p>
    {error && <p role="alert">{error}</p>}
    {!groups && !error && <p>Chargement…</p>}
    <form onSubmit={event => { void create(event); }}>
      <label htmlFor="v2-retailer-new-group">Nouveau groupe</label>
      <input id="v2-retailer-new-group" value={name} maxLength={200}
        onChange={event => setName(event.target.value)} required />
      <button type="submit" className="v2-button v2-button-secondary" disabled={busy}>Créer</button>
    </form>
    {groups?.map(group => <section key={group.id}>
      <h3>{group.name} <small>({group.retailers.reduce((total, retailer) => total + Number(retailer.store_count), 0)} magasins)</small></h3>
      {group.retailers.length === 0 && <p>Aucune enseigne rattachée.</p>}
      {group.retailers.map(retailer => <label key={retailer.id}>
        <span>{retailer.name} · #{retailer.id} · {retailer.store_count} magasin(s)</span>
        <select aria-label={"Groupe de " + retailer.name + " #" + retailer.id}
          value={retailer.group_id} disabled={busy}
          onChange={event => { void assign(retailer.id, Number(event.target.value)); }}>
          {groups.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label>)}
    </section>)}
  </details>;
}
