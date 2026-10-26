import { useEffect, useState, type FormEvent } from "react";

type LastRun = { at: string; result: "current" | "updated" | "failed"; from?: string; to?: string; message?: string };
type Schedule = {
  enabled: boolean;
  time: string;
  timezone: string;
  revision: number;
  scheduler_installed: boolean;
  last_run: LastRun | null;
};
type Draft = Pick<Schedule, "enabled" | "time" | "timezone">;

async function scheduleRequest(method: "GET" | "PUT", body?: object): Promise<Schedule> {
  const response = await fetch("/api/v2/updates/schedule", {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data
      ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : "La planification n’a pas pu être chargée.");
  }
  return response.json() as Promise<Schedule>;
}

export default function V2ServerUpdateSchedule() {
  const [saved, setSaved] = useState<Schedule | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    let active = true;
    void scheduleRequest("GET").then(value => {
      if (active) { setSaved(value); setDraft(value); }
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "Chargement impossible.");
    });
    return () => { active = false; };
  }, []);

  async function reload() {
    setPending(true);
    setError("");
    try {
      const value = await scheduleRequest("GET");
      setSaved(value);
      setDraft(value);
      setConflict(false);
      setNotice("Planification rechargée.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Chargement impossible.");
    } finally {
      setPending(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || !draft || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const value = await scheduleRequest("PUT", { ...draft, expected_revision: saved.revision });
      setSaved(value);
      setDraft(value);
      setConflict(false);
      setNotice(value.enabled ? "Mises à jour quotidiennes planifiées." : "Planification désactivée.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Enregistrement impossible.";
      setError(message);
      setConflict(message.includes("a changé"));
    } finally {
      setPending(false);
    }
  }

  return <section className="v2-settings-card v2-server-schedule" aria-labelledby="v2-schedule-heading">
    <h2 id="v2-schedule-heading">Mises à jour du serveur</h2>
    <p>Planifiez la mise à jour quotidienne de cette instance. Une sauvegarde et les contrôles de santé sont effectués avant sa remise en ligne.</p>
    {draft && saved ? <form onSubmit={event => void save(event)}>
      <label className="v2-schedule-toggle">
        <input type="checkbox" checked={draft.enabled} disabled={pending || (!saved.scheduler_installed && !draft.enabled)}
          onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
        Activer les mises à jour quotidiennes
      </label>
      {!saved.scheduler_installed && <p className="v2-settings-note">Le programmateur système n’est pas installé sur ce serveur.</p>}
      <div className="v2-schedule-fields">
        <label>Heure
          <input type="time" required value={draft.time} disabled={pending}
            onChange={event => setDraft({ ...draft, time: event.target.value })} />
        </label>
        <label>Fuseau horaire
          <select value={draft.timezone} disabled={pending}
            onChange={event => setDraft({ ...draft, timezone: event.target.value })}>
            <option value="Europe/Paris">Europe/Paris</option>
            <option value="UTC">UTC</option>
          </select>
        </label>
      </div>
      <p className="v2-settings-note">À l’heure locale choisie, seule une version validée par la CI est installée. Le site affiche un message de maintenance pendant l’opération. Le passage à l’heure d’été peut sauter une exécution à 02:00.</p>
      <div className="v2-settings-actions">
        <button className="v2-button v2-button-primary" type="submit" disabled={pending || (draft.enabled && !saved.scheduler_installed)}>Enregistrer la planification</button>
        {conflict && <button className="v2-button v2-button-secondary" type="button" onClick={() => void reload()} disabled={pending}>Recharger la version du serveur</button>}
      </div>
      {saved.last_run && <p className="v2-settings-note">Dernière tentative : {new Date(saved.last_run.at).toLocaleString("fr-FR")} — {saved.last_run.result === "updated" ? "mise à jour effectuée" : saved.last_run.result === "current" ? "déjà à jour" : "échec (voir les journaux serveur)"}.</p>}
    </form> : !error && <p role="status">Chargement de la planification…</p>}
    {error && <p className="v2-schedule-error" role="alert">{error}</p>}
    {!draft && error && <button className="v2-button v2-button-secondary" type="button" onClick={() => void reload()} disabled={pending}>Réessayer</button>}
    {notice && <p className="v2-schedule-success" role="status">{notice}</p>}
  </section>;
}
