import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import "./v2-legal.css";

type LegalKind = "mentions" | "confidentialite" | "conditions";

const titles: Record<LegalKind, string> = {
  mentions: "Mentions légales",
  confidentialite: "Confidentialité",
  conditions: "Conditions d’utilisation",
};

export default function V2LegalPage({ kind }: { kind: LegalKind }) {
  const [document, setDocument] = useState<{ kind: LegalKind; text: string } | null>(null);
  const [failed, setFailed] = useState<LegalKind | null>(null);
  useEffect(() => {
    const previous = window.document.title;
    window.document.title = `${titles[kind]} | Price Checker`;
    const controller = new AbortController();
    fetch(`/api/v2/legal/${kind}`, { cache: "no-store", credentials: "omit", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Legal document unavailable");
        return response.text();
      })
      .then((text) => {
        if (!text.trim()) throw new Error("Empty legal document");
        setDocument({ kind, text });
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(kind); });
    return () => { controller.abort(); window.document.title = previous; };
  }, [kind]);

  return <div className="v2-home v2-legal">
    <a className="v2-skip" href="#v2-legal-main">Aller au contenu</a>
    <header className="v2-header">
      <div className="v2-wrap v2-header-inner">
        <Link className="v2-brand" to="/v2" aria-label="Price Checker, accueil V2">
          <span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span>price<span className="v2-brand-accent">checker</span><span className="v2-brand-period">.</span></span>
        </Link>
        <Link className="v2-legal-back" to="/v2">← Retour à l’accueil</Link>
      </div>
    </header>
    <main id="v2-legal-main" className="v2-wrap v2-legal-main">
      <span className="v2-section-kicker">PRICE CHECKER · INFORMATIONS</span>
      <h1>{titles[kind]}<span>.</span></h1>
      <nav className="v2-legal-nav" aria-label="Informations légales">
        <Link to="/v2/mentions-legales" aria-current={kind === "mentions" ? "page" : undefined}>Mentions légales</Link>
        <Link to="/v2/confidentialite" aria-current={kind === "confidentialite" ? "page" : undefined}>Confidentialité</Link>
        <Link to="/v2/conditions-utilisation" aria-current={kind === "conditions" ? "page" : undefined}>Conditions d’utilisation</Link>
      </nav>
      <div className="v2-legal-content" aria-live="polite">
        {document?.kind === kind ? <ReactMarkdown>{document.text}</ReactMarkdown>
          : failed === kind ? <p role="alert">Les informations légales de cette instance sont indisponibles.</p>
            : <p>Chargement des informations légales…</p>}
      </div>
    </main>
  </div>;
}
