import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { useV2Theme } from "./V2ThemeContext";
import { usePwaUpdate } from "../pwa/PwaUpdateState";
import versions from "./component-versions.json";
import V2ServerUpdateSchedule from "./V2ServerUpdateSchedule";
import V2TransferPanel from "./V2TransferPanel";
import V2ModerationPanel from "./V2ModerationPanel";
import "./v2-settings.css";

const updateMessages = {
  idle: "Vérifiez si une nouvelle version de l’application est disponible.",
  checking: "Recherche d’une mise à jour…",
  current: "L’application est à jour.",
  available: "Une nouvelle version est prête à être installée.",
  offline: "Connectez-vous à Internet pour rechercher une mise à jour.",
  unsupported: "La mise à jour automatique n’est pas disponible dans ce navigateur.",
  error: "La vérification a échoué. Réessayez plus tard.",
};

export default function V2SettingsPage({ user }: { user: V2User | null }) {
  const { choice, setChoice } = useV2Theme();
  const { checkState, checkForUpdates, applyUpdate } = usePwaUpdate();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  async function exportAccount() {
    if (exporting) return;
    setExporting(true); setExportError("");
    try {
      const response = await fetch("/api/v2/account/export", {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) throw new Error("L’export n’a pas pu être préparé.");
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = "price-checker-v2-account.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (reason) { setExportError(String(reason)); }
    finally { setExporting(false); }
  }
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Paramètres | Price Checker";
    return () => { document.title = previousTitle; };
  }, []);

  return <div className="v2-home v2-settings">
    <a className="v2-skip" href="#v2-settings-main">Aller au contenu</a>
    <header className="v2-header"><div className="v2-wrap v2-header-inner">
      <Link className="v2-brand" to="/v2" aria-label="Price Checker, accueil V2">
        <span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
        <span>price<span className="v2-brand-accent">checker</span><span className="v2-brand-period">.</span></span>
      </Link>
      <nav className="v2-nav" aria-label="Navigation principale">
        <Link to="/v2">Accueil</Link><Link to="/v2/produits">Produits</Link><Link to="/v2/recettes">Recettes</Link>
        <Link to="/v2/panier">Panier</Link><Link className="v2-nav-current" to="/v2/parametres" aria-current="page">Paramètres</Link>
      </nav>
    </div></header>
    <main id="v2-settings-main" className="v2-wrap v2-settings-main">
      <span className="v2-section-kicker">PRÉFÉRENCES</span>
      <h1>Paramètres<span>.</span></h1>
      <div className="v2-settings-grid">
        <section className="v2-settings-card" aria-labelledby="v2-theme-heading">
          <h2 id="v2-theme-heading">Apparence</h2>
          <p>Choisissez le thème de cet appareil.</p>
          <fieldset className="v2-theme-options">
            <legend>Thème de l’application</legend>
            {([ ["system", "Système"], ["light", "Clair"], ["dark", "Sombre"] ] as const).map(([value, label]) =>
              <label key={value} className={choice === value ? "v2-theme-selected" : ""}>
                <input type="radio" name="v2-theme" value={value} checked={choice === value} onChange={() => setChoice(value)} />
                {label}
              </label>
            )}
          </fieldset>
        </section>
        <section className="v2-settings-card" aria-labelledby="v2-update-heading">
          <h2 id="v2-update-heading">Mises à jour</h2>
          <p>Version installée : <strong>{versions.application.version}</strong></p>
          <p className="v2-settings-status" role="status" aria-live="polite">{updateMessages[checkState]}</p>
          <div className="v2-settings-actions">
            <button type="button" className="v2-button v2-button-secondary" onClick={() => void checkForUpdates()} disabled={checkState === "checking"}>Vérifier les mises à jour</button>
            {checkState === "available" && <button type="button" className="v2-button v2-button-primary" onClick={() => void applyUpdate()}>Mettre à jour l’application</button>}
          </div>
          <p className="v2-settings-note">La mise à jour actualise l’application sur cet appareil, pas le serveur. Elle recharge cette page : terminez vos modifications en cours avant de continuer.</p>
          <Link className="v2-settings-link" to="/v2/versions">Détail des versions →</Link>
        </section>
        {user && <section className="v2-settings-card" aria-labelledby="v2-account-data-heading">
          <h2 id="v2-account-data-heading">Mes données</h2>
          <p>Téléchargez votre compte, vos brouillons, recettes, relevés et signalements au format JSON.</p>
          <button type="button" className="v2-button v2-button-secondary" disabled={exporting}
            onClick={() => { void exportAccount(); }}>{exporting ? "Préparation…" : "Exporter mes données"}</button>
          {exportError && <p role="alert">{exportError}</p>}
        </section>}
        {user?.role === "admin" && <V2ServerUpdateSchedule key={user.id} />}
        {user?.role === "admin" && <V2ModerationPanel />}
        {user?.role === "admin" && <V2TransferPanel key={`transfer-${user.id}`} />}
        {user?.role === "admin" && <section className="v2-settings-card" aria-labelledby="v2-server-heading">
          <h2 id="v2-server-heading">Serveur</h2>
          <p>Nom d’hôte et configuration PostgreSQL de cette instance.</p>
          <Link className="v2-settings-link" to="/v2/settings/database">Paramètres du serveur →</Link>
        </section>}
      </div>
    </main>
  </div>;
}
