import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePwaInstall, type InstallOutcome } from "../pwa/PwaInstallContext";
import { useV2Basket } from "./V2BasketContext";
import V2SiteHeader from "./V2SiteHeader";
import type { V2User } from "./v2-auth-api";
import V2BarcodeSearch from "./V2BarcodeSearch";
import "./v2-product-workspace.css";
import "./v2-home.css";

const installMessages: Record<InstallOutcome, string> = {
  accepted: "Installation lancée. Suivez les indications du navigateur.",
  dismissed: "Installation annulée. Vous pourrez réessayer plus tard.",
  ios: "Sur iPhone ou iPad : touchez Partager, puis Sur l’écran d’accueil.",
  manual: "Si votre navigateur le propose, ouvrez son menu et choisissez Installer l’application.",
  installed: "L’application est déjà installée sur cet appareil.",
  error: "L’installation n’a pas pu démarrer. Réessayez depuis le menu du navigateur.",
};

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.8" cy="10.8" r="6.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="m16 16 4.2 4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function BagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 9h15l-1.2 11H5.7L4.5 9Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M9 9V6.7a3 3 0 0 1 6 0V9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 9V5a1 1 0 0 1 1-1h4m6 0h4a1 1 0 0 1 1 1v4M4 15v4a1 1 0 0 0 1 1h4m6 0h4a1 1 0 0 0 1-1v-4M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function V2HomePage({ user, onLogout }: {
  user: V2User | null;
  onLogout: () => Promise<void>;
}) {
  const { items } = useV2Basket();
  const { installed, requestInstall } = usePwaInstall();
  const [installMessage, setInstallMessage] = useState("");
  const basketCount = items.length;

  async function installApp() {
    setInstallMessage(installMessages[await requestInstall()]);
  }

  useEffect(() => {
    const previousTitle = document.title;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const previousIcon = icon?.getAttribute("href");
    document.title = "Accueil | Price Checker";
    icon?.setAttribute("href", "/v2-mark.svg");

    return () => {
      document.title = previousTitle;
      if (previousIcon) icon?.setAttribute("href", previousIcon);
    };
  }, []);

  return (
    <div className="v2-home">
      <a className="v2-skip" href="#v2-main">Aller au contenu</a>
      <V2SiteHeader user={user} onLogout={onLogout} />

      <main id="v2-main">
        <section className="v2-hero" aria-labelledby="v2-heading">
          <div className="v2-wrap v2-hero-grid">
            <div className="v2-hero-copy">
              <span className="v2-eyebrow"><span className="v2-eyebrow-dot" /> Bienvenue chez Price Checker</span>
              <h1 id="v2-heading">Vos courses,<br /><em>en plus clair.</em></h1>
              <p className="v2-hero-description">
                Trouvez vos produits et préparez votre panier sans vous perdre dans les rayons.
              </p>
              <V2BarcodeSearch compact />
              <div className="v2-hero-actions">
                <Link className="v2-button v2-button-primary" to="/v2/produits">
                  Voir les produits <ArrowIcon />
                </Link>
                <Link className="v2-button v2-button-secondary" to="/v2/panier">
                  Voir mon panier
                </Link>
                {!installed && <button className="v2-button v2-button-secondary" type="button"
                  onClick={() => { void installApp(); }}>Installer l’application</button>}
              </div>
              {installMessage && <p className="v2-install-message" role="status">{installMessage}</p>}
              <p className="v2-hero-note">Un point de départ simple, que ce soit votre première visite ou votre prochaine course.</p>
              <p className="v2-hero-note">Vous développez une intégration ? <a href="/api/v2/docs">Consulter la documentation API</a>.</p>
            </div>

            <div className="v2-hero-visual" aria-label="Aperçu du parcours Price Checker">
              <div className="v2-visual-sun" aria-hidden="true" />
              <div className="v2-visual-spark v2-visual-spark-one" aria-hidden="true">✳</div>
              <div className="v2-visual-spark v2-visual-spark-two" aria-hidden="true">✳</div>
              <div className="v2-journey-card">
                <div className="v2-journey-top">
                  <span className="v2-journey-label">VOTRE PARCOURS</span>
                  <span className="v2-journey-dots" aria-hidden="true"><i /><i /><i /></span>
                </div>
                <div className="v2-journey-title">Les bonnes décisions<br />commencent ici.</div>
                <div className="v2-journey-steps">
                  <div className="v2-journey-step">
                    <span className="v2-step-number">01</span>
                    <span>Je trouve mes produits</span>
                    <span className="v2-step-check" aria-hidden="true">→</span>
                  </div>
                  <div className="v2-journey-step">
                    <span className="v2-step-number">02</span>
                    <span>Je compare les offres</span>
                    <span className="v2-step-check" aria-hidden="true">→</span>
                  </div>
                  <div className="v2-journey-step">
                    <span className="v2-step-number">03</span>
                    <span>Je prépare mon panier</span>
                    <span className="v2-step-check" aria-hidden="true">→</span>
                  </div>
                </div>
                <div className="v2-journey-footer">
                  <span className="v2-journey-avatar"><BagIcon /></span>
                  <span>{basketCount > 0
                    ? basketCount + " article" + (basketCount > 1 ? "s" : "") + " dans votre panier"
                    : "Votre panier vous attend"}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="v2-start v2-wrap" aria-labelledby="v2-start-heading">
          <div className="v2-section-heading">
            <div>
              <span className="v2-section-kicker">À VOUS DE JOUER</span>
              <h2 id="v2-start-heading">Par où commencer ?</h2>
            </div>
            <p>Trois chemins, selon ce que vous voulez faire aujourd’hui.</p>
          </div>
          <div className="v2-action-grid">
            <Link className="v2-action-card" to="/v2/produits">
              <span className="v2-action-icon v2-action-icon-lime"><SearchIcon /></span>
              <span className="v2-action-title">Je cherche un produit</span>
              <span className="v2-action-description">Retrouvez les produits publiés et préparez vos courses.</span>
              <span className="v2-action-link">Explorer les produits <ArrowIcon /></span>
            </Link>
            <Link className="v2-action-card" to="/v2/panier">
              <span className="v2-action-icon v2-action-icon-peach"><BagIcon /></span>
              <span className="v2-action-title">{basketCount > 0 ? "Je reprends mon panier" : "Je prépare mon panier"}</span>
              <span className="v2-action-description">{basketCount > 0
                ? "Retrouvez vos articles et continuez à organiser vos courses."
                : "Gardez produits, groupes et ensembles sous la main pour vos courses."}</span>
              <span className="v2-action-link">Ouvrir mon panier <ArrowIcon /></span>
            </Link>
            <Link className="v2-action-card" to="/v2/produits">
              <span className="v2-action-icon v2-action-icon-blue"><ScanIcon /></span>
              <span className="v2-action-title">Je partage un prix</span>
              <span className="v2-action-description">Choisissez un produit, puis proposez un prix soumis à validation.</span>
              <span className="v2-action-link">Choisir un produit <ArrowIcon /></span>
            </Link>
          </div>
        </section>

        <section className="v2-discover v2-wrap" aria-labelledby="v2-discover-heading">
          <div className="v2-discover-copy">
            <span className="v2-section-kicker">NOUVEAU ICI ?</span>
            <h2 id="v2-discover-heading">Commencez avec un produit que vous connaissez.</h2>
            <p>Parcourez les produits publiés dans le nouveau catalogue V2.</p>
            <Link to="/v2/produits">Voir le catalogue V2 <ArrowIcon /></Link>
          </div>
          <div className="v2-discover-art" aria-hidden="true">
            <div className="v2-discover-ring" />
            <div className="v2-discover-bag"><BagIcon /></div>
            <div className="v2-discover-small-card"><SearchIcon /><span>Un produit à la fois</span></div>
          </div>
        </section>
      </main>

    </div>
  );
}
