import { Link } from "react-router-dom";
import versions from "./component-versions.json";
import "./v2-home.css";

export default function V2SiteFooter() {
  return <footer className="v2-home v2-footer v2-site-footer">
    <div className="v2-wrap v2-footer-inner">
      <div className="v2-footer-meta">
        <span>Price Checker · Des courses plus simples, à votre façon.</span>
        <small>Plateforme développée avec l’aide d’outils d’IA.</small>
      </div>
      <nav className="v2-footer-links" aria-label="Informations et liens externes">
        <Link to="/v2/mentions-legales">Mentions légales</Link>
        <Link to="/v2/confidentialite">Confidentialité</Link>
        <Link to="/v2/conditions-utilisation">Conditions d’utilisation</Link>
        <a href="https://github.com/sinikebe/price-checker-v2">Code source sur GitHub ↗</a>
        <Link to="/v2/versions">Version {versions.application.version} · Détails</Link>
      </nav>
    </div>
  </footer>;
}
