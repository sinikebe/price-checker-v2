import { Link } from "react-router-dom";
import versions from "./component-versions.json";
import "./v2-home.css";
import "./v2-versions.css";

export default function V2VersionsPage() {
  return <div className="v2-home v2-versions">
    <main className="v2-wrap">
      <Link className="v2-versions-back" to="/v2">← Retour à l’accueil</Link>
      <span className="v2-section-kicker">À PROPOS</span>
      <h1>Versions des composants</h1>
      <p>Versions du code de cette installation.</p>
      <p><Link className="v2-versions-changelog" to="/v2/changelog">Voir le journal des nouveautés →</Link></p>
      <div className="v2-versions-list">
        {Object.entries(versions).map(([id, component]) =>
          <div className="v2-versions-item" key={id}>
            <span>{component.label}</span>
            <span className="v2-versions-actions"><strong>{component.version === null ? "Prévu" : `v${component.version}`}</strong><Link to={`/v2/changelog/${id}`}>Nouveautés</Link></span>
          </div>
        )}
      </div>
    </main>
  </div>;
}
