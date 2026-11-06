import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { apiError } from "./v2-http";
import "./v2-legal.css";

type Name = "mentions" | "confidentialite" | "conditions";
type Document = { name: Name; present: boolean; bytes: number; modified_at: string | null; sha256: string | null };
type Listing = { documents: Document[]; max_bytes: number };
type Draft = { name: Name; file: string; text: string; expected: string | null };

const TITLES: Record<Name, string> = { mentions: "Mentions légales", confidentialite: "Confidentialité", conditions: "Conditions d’utilisation" };
const PAGES: Record<Name, string> = { mentions: "/v2/mentions-legales", confidentialite: "/v2/confidentialite", conditions: "/v2/conditions-utilisation" };
const kilobytes = (bytes: number) => (bytes / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " Ko";
const when = (value: string) => new Date(value).toLocaleString("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/v2/legal" + path, { credentials: "same-origin", cache: "no-store", ...init });
  if (!response.ok) throw await apiError(response, "Les documents légaux ne répondent pas. Réessayez.");
  return response.json() as Promise<T>;
}

/**
 * Administrator-only: the legal documents of this installation, replaced from a Markdown file after a
 * preview. The server keeps the replaced version beside the new one.
 */
export default function V2LegalDocuments() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    request<Listing>("").then(value => { if (active) setListing(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Liste indisponible."); });
    return () => { active = false; };
  }, []);

  async function choose(document: Document, file: File | undefined) {
    setError(""); setNotice("");
    if (!file || !listing) return;
    if (file.size > listing.max_bytes) { setError(`« ${file.name} » dépasse ${kilobytes(listing.max_bytes)}.`); return; }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
    catch { setError(`« ${file.name} » n’est pas un texte UTF-8.`); return; }
    if (!text.trim()) { setError(`« ${file.name} » est vide.`); return; }
    setDraft({ name: document.name, file: file.name, text: text.replace(/^\uFEFF/, ""), expected: document.sha256 });
  }

  async function publish() {
    if (!draft || busy) return;
    setBusy(true); setError("");
    try {
      const saved = await request<Document>("/" + draft.name, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft.text, expected_sha256: draft.expected }),
      });
      setListing(current => current && { ...current, documents: current.documents.map(item => item.name === saved.name ? saved : item) });
      setNotice(`${TITLES[draft.name]} : nouvelle version publiée (${kilobytes(saved.bytes)}).`);
      setDraft(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Échec de la publication."); }
    finally { setBusy(false); }
  }

  return <section className="v2-settings-card v2-legal-documents" aria-labelledby="v2-legal-documents-heading">
    <h2 id="v2-legal-documents-heading">Documents légaux</h2>
    <p>Les mentions légales, la notice de confidentialité et les conditions d’utilisation de cette instance, en Markdown
      ({listing ? kilobytes(listing.max_bytes) : "128 Ko"} au plus). Choisissez un fichier, vérifiez l’aperçu, puis publiez : la page change aussitôt
      et la version remplacée reste gardée sur le serveur. Ces fichiers ne sont jamais versés au dépôt.</p>
    {!listing ? (error ? <p role="alert" className="v2-schedule-error">{error}</p> : <p>Chargement…</p>) : <>
      <ul className="v2-legal-documents-list">{listing.documents.map(document => <li key={document.name}>
        <div><strong>{TITLES[document.name]}</strong>
          <small>{document.present && document.modified_at ? `${kilobytes(document.bytes)} · modifié le ${when(document.modified_at)}` : "Absent : la page signale son indisponibilité."}</small>
          {document.present && <a href={PAGES[document.name]} target="_blank" rel="noreferrer">Voir la page ↗</a>}</div>
        <label className="v2-button v2-button-secondary">Remplacer depuis un fichier
          <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="v2-legal-file"
            aria-label={`Fichier Markdown pour ${TITLES[document.name]}`} disabled={busy}
            onChange={event => { void choose(document, event.target.files?.[0]); event.target.value = ""; }} /></label>
      </li>)}</ul>
      {draft && <div className="v2-legal-preview" role="region" aria-label={`Aperçu : ${TITLES[draft.name]}`}>
        <p><strong>Aperçu de « {draft.file} »</strong> pour {TITLES[draft.name]} · {kilobytes(new TextEncoder().encode(draft.text).length)}</p>
        <div className="v2-legal-content v2-legal-preview-body"><ReactMarkdown>{draft.text}</ReactMarkdown></div>
        <div className="v2-legal-preview-actions">
          <button type="button" className="v2-button v2-button-primary" disabled={busy} onClick={() => void publish()}>{busy ? "Publication…" : "Publier ce document"}</button>
          <button type="button" className="v2-button v2-button-secondary" disabled={busy} onClick={() => setDraft(null)}>Annuler</button>
        </div>
      </div>}
      {error && <p role="alert" className="v2-schedule-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </>}
  </section>;
}
