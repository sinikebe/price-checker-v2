import { useEffect, useState, type FormEvent } from "react";

type Settings = { complete_list_max: number; revision: number; min: number; max: number; per_minute: number; per_hour: number };

async function settingsRequest(method: "GET" | "PUT", body?: object): Promise<Settings> {
  const response = await fetch("/api/v2/catalogue/search-settings", {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : "Le réglage n’a pas pu être enregistré.");
  }
  return response.json() as Promise<Settings>;
}

/** Administrator setting of the catalogue search: how many matches the server lists in full. */
export default function V2SearchSettings() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    settingsRequest("GET")
      .then(settings => { if (active) { setSaved(settings); setDraft(String(settings.complete_list_max)); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Le réglage n’a pas pu être chargé."); });
    return () => { active = false; };
  }, []);

  const value = Number(draft);
  const valid = saved !== null && draft.trim() !== "" && Number.isInteger(value) && value >= saved.min && value <= saved.max;
  const changed = saved !== null && valid && value !== saved.complete_list_max;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!saved || !valid || pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      const next = await settingsRequest("PUT", { complete_list_max: value, expected_revision: saved.revision });
      setSaved(next); setDraft(String(next.complete_list_max));
      setNotice("Réglage enregistré.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Le réglage n’a pas pu être enregistré.");
      settingsRequest("GET").then(settings => { setSaved(settings); setDraft(String(settings.complete_list_max)); }).catch(() => undefined);
    } finally { setPending(false); }
  }

  return <section className="v2-settings-card v2-search-settings" aria-labelledby="v2-search-settings-heading">
    <h2 id="v2-search-settings-heading">Recherche dans le catalogue</h2>
    <p>La recherche s’affiche au fil de la saisie. Le serveur n’envoie la liste complète que lorsque peu de produits correspondent ; au-delà, il indique seulement leur nombre, puis le navigateur filtre la liste reçue sans nouvelle requête.</p>
    {saved === null ? (error ? <p className="v2-schedule-error" role="alert">{error}</p> : <p>Chargement…</p>) : <form onSubmit={save}>
      <div className="v2-schedule-fields">
        <label>Nombre maximal de produits listés
          <input type="number" inputMode="numeric" min={saved.min} max={saved.max} step={1} required value={draft}
            aria-describedby="v2-search-settings-help" onChange={event => { setDraft(event.target.value); setNotice(""); }} />
        </label>
      </div>
      <p className="v2-settings-note" id="v2-search-settings-help">
        Entre {saved.min} et {saved.max}. Chaque visiteur peut lancer {saved.per_minute} recherches par minute et {saved.per_hour} par heure.
      </p>
      <div className="v2-settings-actions">
        <button type="submit" className="v2-button v2-button-primary" disabled={!changed || pending}>{pending ? "Enregistrement…" : "Enregistrer"}</button>
      </div>
      {!valid && draft.trim() !== "" && <p className="v2-schedule-error" role="alert">Saisissez un nombre entier entre {saved.min} et {saved.max}.</p>}
      {error && <p className="v2-schedule-error" role="alert">{error}</p>}
      {notice && <p className="v2-schedule-success" role="status">{notice}</p>}
    </form>}
  </section>;
}
