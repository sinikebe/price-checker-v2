import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

type Change = { version: string; notes: string[] };
type Connector = { id: string; name: string; version: string; changelog: Change[] };
type Installation = { connector_id: string; version: string; commit_sha: string; enabled: boolean;
  previous_commit: string | null; previous_version: string | null };
type Store = {
  id: number; name: string; repository: string; private: boolean; has_key: boolean;
  public_key: string | null; fetched_commit: string | null; fetched_at: string | null;
  catalog: Connector[]; installations: Installation[];
};
type Result = { stores: Store[] };
const base = "/api/v2/connector-stores";
const newer = (candidate: string, installed: string) => {
  const next = candidate.split(".").map(Number);
  const current = installed.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (next[index] !== current[index]) return next[index] > current[index];
  }
  return false;
};

async function request(url: string, method = "GET", body?: unknown): Promise<Result> {
  const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(detail?.detail || "Opération impossible.");
  }
  return response.json() as Promise<Result>;
}

export default function V2ConnectorStores() {
  const [stores, setStores] = useState<Store[]>([]);
  const [name, setName] = useState("");
  const [repository, setRepository] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [privateKey, setPrivateKey] = useState("");
  const [replacementKeys, setReplacementKeys] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void request(base).then(value => { if (active) setStores(value.stores); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);
  async function action(url: string, method = "POST", body?: unknown, success = "Modifications enregistrées.") {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await request(url, method, body);
      setStores(value.stores); setNotice(success);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await request(base, "POST", { name, repository, private: isPrivate,
        private_key: isPrivate && privateKey ? privateKey : null });
      setStores(value.stores); setName(""); setRepository(""); setPrivateKey("");
      setNotice("Store ajouté. Récupérez son catalogue pour voir les connecteurs.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  function change(store: Store, connector: Connector, actionName: "install" | "update" | "rollback" | "enable" | "disable") {
    const installed = store.installations.find(item => item.connector_id === connector.id);
    void action(`${base}/${store.id}/connectors/${connector.id}`, "PUT", {
      action: actionName, expected_commit: store.fetched_commit,
      expected_installed_commit: installed?.commit_sha ?? null,
    }, `Connecteur ${actionName === "install" ? "installé" : actionName === "update" ? "mis à jour" : actionName === "rollback" ? "restauré" : actionName === "enable" ? "activé" : "désactivé"}.`);
  }
  return <section className="v2-settings-card v2-connector-stores" aria-labelledby="v2-connector-stores-heading">
    <h2 id="v2-connector-stores-heading">Stores de connecteurs</h2>
    <p>Ajoutez un dépôt GitHub, récupérez son catalogue, puis choisissez les connecteurs à installer. Le code installé est épinglé à une révision Git ; une nouvelle version ne s’active pas seule. N’ajoutez que des dépôts de confiance : leur code s’exécute sur le serveur.</p>
    <form onSubmit={event => void add(event)}>
      <label>Nom du store<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>URL du dépôt GitHub<input required type="url" placeholder="https://github.com/organisation/connecteurs" value={repository} onChange={event => setRepository(event.target.value)} /></label>
      <label className="v2-schedule-toggle"><input type="checkbox" checked={isPrivate} onChange={event => setPrivate(event.target.checked)} />Dépôt privé</label>
      {isPrivate && <label>Clé privée SSH existante (facultatif)
        <textarea value={privateKey} onChange={event => setPrivateKey(event.target.value)} rows={3} autoComplete="off" placeholder="Laissez vide pour générer une clé après l’ajout" />
      </label>}
      <button className="v2-button v2-button-primary" type="submit" disabled={busy}>Ajouter le store</button>
    </form>
    {stores.map(store => <div className="v2-connector-store" key={store.id}>
      <h3>{store.name}</h3>
      <p><code>{store.repository}</code> · {store.private ? "privé" : "public"}</p>
      {store.private && <div>
        {store.public_key ? <><p>Ajoutez cette clé publique comme <strong>deploy key en lecture seule</strong> sur le dépôt GitHub :</p>
          <textarea readOnly aria-label={`Clé publique de ${store.name}`} value={store.public_key} rows={2} /></>
          : <button className="v2-button" type="button" disabled={busy} onClick={() => void action(`${base}/${store.id}/key/generate`, "POST", undefined, "Clé générée. Ajoutez la clé publique au dépôt GitHub.")}>Générer une clé SSH</button>}
        <details><summary>Remplacer la clé privée</summary><form onSubmit={event => {
          event.preventDefault();
          const value = replacementKeys[store.id];
          if (!value) return;
          void action(`${base}/${store.id}/key`, "PUT", { private_key: value }, "Clé remplacée.");
          setReplacementKeys(keys => ({ ...keys, [store.id]: "" }));
        }}><textarea aria-label={`Nouvelle clé privée de ${store.name}`} value={replacementKeys[store.id] ?? ""} onChange={event => setReplacementKeys(keys => ({ ...keys, [store.id]: event.target.value }))} rows={3} autoComplete="off" required />
          <button className="v2-button" type="submit" disabled={busy}>Remplacer</button></form></details>
      </div>}
      <div className="v2-settings-actions">
        <button className="v2-button" type="button" disabled={busy} onClick={() => void action(`${base}/${store.id}/refresh`, "POST", undefined, "Catalogue récupéré.")}>Récupérer le catalogue</button>
        <button className="v2-button v2-button-secondary" type="button" disabled={busy} onClick={() => {
          if (window.confirm(`Supprimer le store ${store.name} et désinstaller ses connecteurs ? Les anciens prix seront conservés.`))
            void action(`${base}/${store.id}`, "DELETE", undefined, "Store supprimé.");
        }}>Supprimer le store</button>
      </div>
      {store.fetched_at && <p>Catalogue vérifié le {new Date(store.fetched_at).toLocaleString("fr-FR")}. Les installations restent sur leur révision tant que vous ne les mettez pas à jour.</p>}
      {store.catalog.map(connector => {
        const installed = store.installations.find(item => item.connector_id === connector.id);
        const update = installed && newer(connector.version, installed.version);
        return <div className="v2-connector-item" key={connector.id}>
          <h4>{connector.name} · v{connector.version}</h4>
          <p>{installed ? `Installé : v${installed.version} · ${installed.enabled ? "actif" : "désactivé"}` : "Non installé"} · {installed && <Link to={`/v2/versions#connector-${connector.id}`}>Journal installé</Link>}</p>
          <details><summary>Journal des versions du store</summary>{connector.changelog.map(change => <div key={change.version}><strong>v{change.version}</strong><ul>{change.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></div>)}</details>
          {!installed && <button className="v2-button" type="button" disabled={busy} onClick={() => change(store, connector, "install")}>Installer</button>}
          {installed && <div className="v2-settings-actions">
            <button className="v2-button" type="button" disabled={busy} onClick={() => change(store, connector, installed.enabled ? "disable" : "enable")}>{installed.enabled ? "Désactiver" : "Activer"}</button>
            {update && <button className="v2-button" type="button" disabled={busy} onClick={() => change(store, connector, "update")}>Mettre à jour vers v{connector.version}</button>}
            {installed.previous_commit && <button className="v2-button" type="button" disabled={busy} onClick={() => change(store, connector, "rollback")}>Restaurer v{installed.previous_version}</button>}
            <button className="v2-button v2-button-secondary" type="button" disabled={busy} onClick={() => {
              if (window.confirm(`Désinstaller ${connector.name} ? Les anciens prix seront conservés.`))
                void action(`${base}/${store.id}/connectors/${connector.id}`, "DELETE", undefined, "Connecteur désinstallé.");
            }}>Désinstaller</button>
          </div>}
        </div>;
      })}
      {store.installations.filter(item => !store.catalog.some(connector => connector.id === item.connector_id)).map(item =>
        <div className="v2-connector-item" key={item.connector_id}>
          <h4>{item.connector_id} · v{item.version}</h4>
          <p>Installé mais absent du dernier catalogue · {item.enabled ? "actif" : "désactivé"} · <Link to={`/v2/versions#connector-${item.connector_id}`}>Journal installé</Link></p>
          <div className="v2-settings-actions">
            <button className="v2-button" type="button" disabled={busy} onClick={() => change(store,
              { id: item.connector_id, name: item.connector_id, version: item.version, changelog: [] }, item.enabled ? "disable" : "enable")}>{item.enabled ? "Désactiver" : "Activer"}</button>
            {item.previous_commit && <button className="v2-button" type="button" disabled={busy} onClick={() => change(store,
              { id: item.connector_id, name: item.connector_id, version: item.version, changelog: [] }, "rollback")}>Restaurer v{item.previous_version}</button>}
            <button className="v2-button v2-button-secondary" type="button" disabled={busy} onClick={() => {
              if (window.confirm(`Désinstaller ${item.connector_id} ? Les anciens prix seront conservés.`))
                void action(`${base}/${store.id}/connectors/${item.connector_id}`, "DELETE", undefined, "Connecteur désinstallé.");
            }}>Désinstaller</button>
          </div>
        </div>)}
    </div>)}
    {error && <p role="alert" className="v2-schedule-error">{error}</p>}
    {notice && <p role="status" className="v2-schedule-success">{notice}</p>}
  </section>;
}
