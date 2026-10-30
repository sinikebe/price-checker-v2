import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

type Connector = { id: string; name: string; version: string; enabled: boolean;
  changelog: { version: string; notes: string[] }[] };

export default function V2ConnectorVersions() {
  const [items, setItems] = useState<Connector[]>([]);
  const [error, setError] = useState("");
  const location = useLocation();
  useEffect(() => {
    let active = true;
    void fetch("/api/v2/connector-stores/versions", { cache: "no-store" })
      .then(response => { if (!response.ok) throw new Error("Versions des connecteurs indisponibles."); return response.json(); })
      .then((result: { connectors: Connector[] }) => { if (active) setItems(result.connectors); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!items.length || !location.hash.startsWith("#connector-")) return;
    const target = document.getElementById(location.hash.slice(1));
    target?.scrollIntoView({ block: "start" });
  }, [items, location.hash]);
  return <section id="connecteurs" className="v2-connector-versions">
    <h2>Connecteurs</h2>
    {items.length ? <div className="v2-versions-list">{items.map(item =>
      <details id={`connector-${item.id}`} key={item.id} open={location.hash === `#connector-${item.id}`} className="v2-versions-item">
        <summary>{item.name} · v{item.version}{!item.enabled && " · désactivé"} · Journal des versions</summary>
        {item.changelog.map(change => <div key={change.version}>
          <h3>v{change.version}</h3>
          <ul>{change.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
        </div>)}
      </details>)}</div> : !error && <p>Aucun connecteur installé sur cette instance.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
