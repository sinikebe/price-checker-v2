import { useEffect, useState, type FormEvent } from "react";
import V2Info from "./V2Info";
import { useConfirm } from "./useConfirm";
import { Link } from "react-router-dom";
import V2ConnectorSettings from "./V2ConnectorSettings";
import { forgetEnabledConnectors } from "./v2-connector-refresh";
import { errorText, requestJson } from "./v2-http";

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
type Action = "install" | "update" | "rollback" | "enable" | "disable";
/** The notice after each connector action: "Connecteur installé.", "Connecteur activé."… */
const DONE: Record<Action, string> = { install: "installé", update: "mis à jour", rollback: "restauré", enable: "activé", disable: "désactivé" };
const base = "/api/v2/connector-stores";
const newer = (candidate: string, installed: string) => {
  const next = candidate.split(".").map(Number);
  const current = installed.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (next[index] !== current[index]) return next[index] > current[index];
  }
  return false;
};

function request(url: string, method = "GET", body?: object): Promise<Result> {
  return requestJson<Result>(url, { method, body, cache: "no-store", fallback: "Opération impossible." });
}

/** The controls of an installed connector; an installation missing from the catalogue cannot be updated. */
function InstalledControls({ connector, installed, canUpdate, busy, onChange, onUninstall }: {
  connector: Connector; installed: Installation; canUpdate: boolean; busy: boolean;
  onChange: (action: Action) => void; onUninstall: () => void;
}) {
  const confirm = useConfirm();
  return <div className="v2-settings-actions">
    <button className="v2-button" type="button" disabled={busy} onClick={() => onChange(installed.enabled ? "disable" : "enable")}>{installed.enabled ? "Désactiver" : "Activer"}</button>
    {canUpdate && <button className="v2-button" type="button" disabled={busy} onClick={() => onChange("update")}>Mettre à jour vers v{connector.version}</button>}
    {installed.previous_commit && <button className="v2-button" type="button" disabled={busy} onClick={() => onChange("rollback")}>Restaurer v{installed.previous_version}</button>}
    <button className="v2-button v2-button-secondary" type="button" disabled={busy} onClick={async () => {
      if (await confirm({ title: "Désinstaller le connecteur", message: `Désinstaller ${connector.name} ? Les anciens prix seront conservés.`, confirmLabel: "Désinstaller", danger: true }))
        onUninstall();
    }}>Désinstaller</button>
  </div>;
}

export default function V2ConnectorStores() {
  const confirm = useConfirm();
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
      .catch(reason => { if (active) setError(errorText(reason, "Opération impossible.")); });
    return () => { active = false; };
  }, []);
  /** `onDone` runs only once the server accepted the change: a refused one keeps what was typed. */
  async function action(url: string, method = "POST", body?: object, success = "Modifications enregistrées.", onDone?: () => void) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await request(url, method, body);
      // The price pages and the basket share a cached connector list: an install, a switch or an
      // uninstall must show on the next page opened, not 30 seconds later.
      forgetEnabledConnectors();
      setStores(value.stores); setNotice(success);
      onDone?.();
    } catch (reason) { setError(errorText(reason, "Opération impossible.")); }
    finally { setBusy(false); }
  }
  function add(event: FormEvent) {
    event.preventDefault();
    void action(base, "POST", { name, repository, private: isPrivate, private_key: isPrivate && privateKey ? privateKey : null },
      "Store ajouté. Récupérez son catalogue pour voir les connecteurs.", () => { setName(""); setRepository(""); setPrivateKey(""); });
  }
  function change(store: Store, connector: Connector, actionName: Action) {
    const installed = store.installations.find(item => item.connector_id === connector.id);
    void action(`${base}/${store.id}/connectors/${connector.id}`, "PUT", {
      action: actionName, expected_commit: store.fetched_commit,
      expected_installed_commit: installed?.commit_sha ?? null,
    }, `Connecteur ${DONE[actionName]}.`);
  }
  const uninstall = (store: Store, connectorId: string) =>
    void action(`${base}/${store.id}/connectors/${connectorId}`, "DELETE", undefined, "Connecteur désinstallé.");
  return <section className="v2-settings-card v2-connector-stores" aria-labelledby="v2-connector-stores-heading">
    <h2 id="v2-connector-stores-heading">Stores de connecteurs <V2Info>Ajoutez un dépôt GitHub, récupérez son catalogue, puis choisissez les connecteurs à installer. Le code installé est épinglé à une révision Git ; une nouvelle version ne s’active pas seule.</V2Info></h2>
    <p>N’ajoutez que des dépôts de confiance : leur code s’exécute sur le serveur.</p>
    <form onSubmit={add}>
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
          void action(`${base}/${store.id}/key`, "PUT", { private_key: value }, "Clé remplacée.",
            () => setReplacementKeys(keys => ({ ...keys, [store.id]: "" })));
        }}><textarea aria-label={`Nouvelle clé privée de ${store.name}`} value={replacementKeys[store.id] ?? ""} onChange={event => setReplacementKeys(keys => ({ ...keys, [store.id]: event.target.value }))} rows={3} autoComplete="off" required />
          <button className="v2-button" type="submit" disabled={busy}>Remplacer</button></form></details>
      </div>}
      <div className="v2-settings-actions">
        <button className="v2-button" type="button" disabled={busy} onClick={() => void action(`${base}/${store.id}/refresh`, "POST", undefined, "Catalogue récupéré.")}>Récupérer le catalogue</button>
        <button className="v2-button v2-button-secondary" type="button" disabled={busy} onClick={async () => {
          if (await confirm({ title: "Supprimer le store", message: `Supprimer le store ${store.name} et désinstaller ses connecteurs ? Les anciens prix seront conservés.`, confirmLabel: "Supprimer", danger: true }))
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
          {installed && <InstalledControls connector={connector} installed={installed} canUpdate={Boolean(update)} busy={busy}
            onChange={actionName => change(store, connector, actionName)} onUninstall={() => uninstall(store, connector.id)} />}
          {installed && <V2ConnectorSettings key={`${installed.commit_sha}-${installed.enabled}`}
            storeId={store.id} connectorId={connector.id} installationEnabled={installed.enabled} />}
        </div>;
      })}
      {store.installations.filter(item => !store.catalog.some(connector => connector.id === item.connector_id)).map(item => {
        // Absent from the catalogue: the installation itself names the connector.
        const connector: Connector = { id: item.connector_id, name: item.connector_id, version: item.version, changelog: [] };
        return <div className="v2-connector-item" key={item.connector_id}>
          <h4>{item.connector_id} · v{item.version}</h4>
          <p>Installé mais absent du dernier catalogue · {item.enabled ? "actif" : "désactivé"} · <Link to={`/v2/versions#connector-${item.connector_id}`}>Journal installé</Link></p>
          <InstalledControls connector={connector} installed={item} canUpdate={false} busy={busy}
            onChange={actionName => change(store, connector, actionName)} onUninstall={() => uninstall(store, connector.id)} />
          <V2ConnectorSettings key={`${item.commit_sha}-${item.enabled}`}
            storeId={store.id} connectorId={item.connector_id} installationEnabled={item.enabled} />
        </div>;
      })}
    </div>)}
    {error && <p role="alert" className="v2-schedule-error">{error}</p>}
    {notice && <p role="status" className="v2-schedule-success">{notice}</p>}
  </section>;
}
