import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import V2Brand from "./V2Brand";
import V2LegalMarkdown from "./V2LegalMarkdown";
import { useDocumentTitle } from "./useDocumentTitle";
import { LEGAL_DOCUMENTS, legalDocument, type LegalKind } from "./v2-legal-documents";
import "./v2-legal.css";

export default function V2LegalPage({ kind }: { kind: LegalKind }) {
  const [document, setDocument] = useState<{ kind: LegalKind; text: string } | null>(null);
  const [failed, setFailed] = useState<LegalKind | null>(null);
  const { title } = legalDocument(kind);
  useDocumentTitle(`${title} | Price Checker`);
  useEffect(() => {
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
    return () => controller.abort();
  }, [kind]);

  return <div className="v2-home v2-legal">
    <a className="v2-skip" href="#v2-legal-main">Aller au contenu</a>
    <header className="v2-header">
      <div className="v2-wrap v2-header-inner">
        <V2Brand />
        <Link className="v2-legal-back" to="/v2">← Retour à l’accueil</Link>
      </div>
    </header>
    <main id="v2-legal-main" className="v2-wrap v2-legal-main">
      <span className="v2-section-kicker">PRICE CHECKER · INFORMATIONS</span>
      <h1>{title}<span>.</span></h1>
      <nav className="v2-legal-nav" aria-label="Informations légales">
        {LEGAL_DOCUMENTS.map(item => <Link key={item.kind} to={item.path} aria-current={kind === item.kind ? "page" : undefined}>{item.title}</Link>)}
      </nav>
      <div className="v2-legal-content" aria-live="polite">
        {document?.kind === kind ? <V2LegalMarkdown text={document.text} />
          : failed === kind ? <p role="alert">Les informations légales de cette instance sont indisponibles.</p>
            : <p>Chargement des informations légales…</p>}
      </div>
    </main>
  </div>;
}
