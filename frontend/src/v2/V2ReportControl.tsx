import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { moderationRequest } from "./v2-moderation-api";

type Kind = "product" | "recipe";

export default function V2ReportControl({ kind, contentId, user }: {
  kind: Kind; contentId: number; user: V2User | null;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await moderationRequest("/reports", "POST", { kind, content_id: contentId, reason: reason.trim() });
      setDone(true);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="v2-workspace-card">
    <h2>Signaler ce contenu</h2>
    {done ? <p role="status">Signalement envoyé. Il sera examiné par un administrateur.</p> :
      !user ? <p><Link to="/v2/connexion">Connectez-vous</Link> pour signaler ce contenu.</p> :
      !open ? <button type="button" className="v2-button v2-button-secondary" onClick={() => setOpen(true)}>Signaler</button> :
      <form onSubmit={event => { void submit(event); }}>
        <label htmlFor={"report-reason-" + kind + "-" + contentId}>Motif du signalement</label>
        <textarea id={"report-reason-" + kind + "-" + contentId} value={reason}
          minLength={10} maxLength={1000} required rows={3}
          onChange={event => setReason(event.target.value)} />
        <div className="v2-workspace-actions">
          <button type="submit" className="v2-button v2-button-primary" disabled={busy || reason.trim().length < 10}>Envoyer</button>
          <button type="button" className="v2-button v2-button-secondary" onClick={() => setOpen(false)}>Annuler</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>}
  </section>;
}
