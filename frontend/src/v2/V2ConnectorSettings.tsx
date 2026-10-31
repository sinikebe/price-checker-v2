import { useEffect, useState, type FormEvent } from "react";

type Field = { key: string; label: string; type: "boolean" | "integer"; min?: number; max?: number };
type Settings = {
  revision: number; fields: Field[]; values: Record<string, boolean | number>;
  status?: { pending_count?: number; paused_at?: string | null;
    eligible_count?: number; consecutive_failures?: number; next_run_at?: string | null };
};

export default function V2ConnectorSettings({ storeId, connectorId, version, installationEnabled }: {
  storeId: number; connectorId: string; version: string; installationEnabled: boolean;
}) {
  const endpoint = `/api/v2/connector-stores/${storeId}/connectors/${encodeURIComponent(connectorId)}/settings`;
  const [saved, setSaved] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Settings["status"]>();
  const [draft, setDraft] = useState<Record<string, boolean | number>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetch(endpoint, { credentials: "same-origin", cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error(response.status === 404
        ? "Cette version du connecteur ne propose pas encore de réglages dans l’application."
        : "Impossible de lire les réglages du connecteur.");
      return response.json() as Promise<Settings>;
    }).then(value => {
      if (active) { setSaved(value); setDraft(value.values); setStatus(value.status); setError(""); }
    }).catch(reason => { if (active) setError(String(reason)); });
    const timer = window.setInterval(() => {
      void fetch(endpoint, { credentials: "same-origin", cache: "no-store" })
        .then(response => response.ok ? response.json() as Promise<Settings> : null)
        .then(value => { if (active && value) setStatus(value.status); })
        .catch(() => { /* Keep the last readable count and any unsaved draft. */ });
    }, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [endpoint, version, open]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!saved || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, { method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: saved.revision, values: draft }) });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(body?.detail || "Impossible d’enregistrer les réglages.");
      }
      const value = await response.json() as Settings;
      setSaved(value); setDraft(value.values); setStatus(value.status);
      setNotice("Réglages enregistrés.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <details className="v2-connector-settings" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Réglages du connecteur</summary>
    {!installationEnabled && <p role="status">Installation désactivée : aucun relevé ne sera lancé, même si les relevés sont autorisés ci-dessous. Réactivez le connecteur dans le store pour reprendre.</p>}
    {saved && <form onSubmit={event => void save(event)}>
      {saved.fields.map(field => <label key={field.key}>
        {field.type === "boolean"
          ? <><input type="checkbox" checked={draft[field.key] === true}
              onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.checked }))} /> {field.label}</>
          : <>{field.label}<input type="number" required step="1" min={field.min} max={field.max}
              value={typeof draft[field.key] === "number" ? draft[field.key] as number : ""}
              onChange={event => setDraft(current => ({ ...current, [field.key]: Number(event.target.value) }))} /></>}
      </label>)}
      <button className="v2-button v2-button-primary" type="submit" disabled={busy}>
        {busy ? "Enregistrement…" : "Enregistrer les réglages"}</button>
      {status && <p role="status">
        {status.pending_count ?? 0} produit(s) en attente.
        {status.eligible_count !== undefined && ` ${status.eligible_count} produit(s) éligible(s) hors file.`}
        {status.paused_at && ` Suspendu après ${status.consecutive_failures ?? 0} échecs ; réactivez le connecteur dans le store après vérification.`}
        {status.next_run_at && ` Prochain départ au plus tôt : ${new Date(status.next_run_at).toLocaleString("fr-FR")}.`}
      </p>}
    </form>}
    {error && <p role="alert" className="v2-schedule-error">{error}</p>}
    {notice && <p role="status" className="v2-schedule-success">{notice}</p>}
  </details>;
}
