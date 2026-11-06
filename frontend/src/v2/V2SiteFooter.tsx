import { Link } from "react-router-dom";
import versions from "./component-versions.json";
import { LEGAL_DOCUMENTS } from "./v2-legal-documents";
import "./v2-home.css";

export default function V2SiteFooter() {
  return <footer className="v2-home v2-footer v2-site-footer">
    <div className="v2-wrap v2-footer-inner">
      <div className="v2-footer-meta">
        <span>Price Checker · Des courses plus simples, à votre façon.</span>
        <small>Plateforme développée avec l’aide d’outils d’IA.</small>
      </div>
      <nav className="v2-footer-links" aria-label="Informations et liens externes">
        {LEGAL_DOCUMENTS.map(item => <Link key={item.kind} to={item.path}>{item.title}</Link>)}
        <a href="https://github.com/sinikebe/price-checker-v2">Code source sur GitHub ↗</a>
        <Link to="/v2/changelog">Nouveautés</Link>
        <a href="/api/v2/docs">Documentation API</a>
        <Link to="/v2/versions">Version {versions.application.version} · Détails</Link>
      </nav>
    </div>
  </footer>;
}
