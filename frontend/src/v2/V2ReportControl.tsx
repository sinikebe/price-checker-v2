import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { moderationRequest } from "./v2-moderation-api";

type Kind = "product" | "recipe" | "store";
type ReportType = "general" | "duplicate";

export default function V2ReportControl({ kind, contentId, user }: {
  kind: Kind; contentId: number; user: V2User | null;
}) {
  const [open, setOpen] = useState<ReportType | null>(null);
  const [reason, setReason] = useState("");
  const [duplicateUrl, setDuplicateUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !open) return;
    setBusy(true); setError("");
    try {
      await moderationRequest("/reports", "POST", {
        kind, content_id: contentId, report_type: open,
        reason: open === "general" ? reason.trim() : reason.trim() || "Doublon potentiel",
        duplicate_url: open === "duplicate" ? duplicateUrl.trim() || null : null,
      });
      setDone(true);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="v2-workspace-card">
    <h2>Signaler cette fiche</h2>
    {done ? <p role="status">Signalement envoyé. Il sera examiné par un administrateur.</p> :
      !user ? <p><Link to="/v2/connexion">Connectez-vous</Link> pour signaler cette fiche.</p> :
      !open ? <div className="v2-workspace-actions">
        {kind !== "store" && <button type="button" className="v2-button v2-button-secondary" onClick={() => setOpen("general")}>Signaler un problème</button>}
        {kind !== "recipe" && <button type="button" className="v2-button v2-button-secondary" onClick={() => setOpen("duplicate")}>Signaler un doublon</button>}
      </div> : <form onSubmit={event => { void submit(event); }}>
        <h3>{open === "duplicate" ? "Doublon potentiel" : "Problème sur la fiche"}</h3>
        {open === "duplicate" && <><label htmlFor={"report-url-" + kind + "-" + contentId}>URL de l’autre fiche (facultative)</label>
          <input id={"report-url-" + kind + "-" + contentId} type="url" value={duplicateUrl}
            placeholder={window.location.origin + "/v2/" + (kind === "product" ? "produits" : "magasins") + "/123"}
            onChange={event => setDuplicateUrl(event.target.value)} />
          <p>L’administrateur pourra rechercher le doublon si vous n’avez pas son lien.</p></>}
        <label htmlFor={"report-reason-" + kind + "-" + contentId}>{open === "duplicate" ? "Précisions (facultatives)" : "Motif du signalement"}</label>
        <textarea id={"report-reason-" + kind + "-" + contentId} value={reason}
          minLength={open === "general" ? 10 : undefined} maxLength={1000} required={open === "general"} rows={3}
          onChange={event => setReason(event.target.value)} />
        <p>N’indiquez ni nom de personne ni coordonnées. Ce texte reste privé aux modérateurs.</p>
        <div className="v2-workspace-actions">
          <button type="submit" className="v2-button v2-button-primary" disabled={busy || (open === "general" && reason.trim().length < 10)}>Envoyer</button>
          <button type="button" className="v2-button v2-button-secondary" onClick={() => setOpen(null)}>Annuler</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>}
  </section>;
}
