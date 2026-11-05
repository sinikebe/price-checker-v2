import { useEffect, useState, type FormEvent } from "react";

type ReferenceSettings = { unused_days: number; revision: number; count: number; min: number; max: number };

async function request(method: "GET" | "PUT", body?: object): Promise<ReferenceSettings> {
  const response = await fetch("/api/v2/product-references/settings", {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload ? (payload as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : "Le réglage n’a pas pu être chargé.");
  }
  return payload as ReferenceSettings;
}

/** Administrator setting: how long an unused product known only by its barcode is kept. */
export default function V2ReferenceSettings() {
  const [saved, setSaved] = useState<ReferenceSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    request("GET")
      .then(settings => { if (active) { setSaved(settings); setDraft(String(settings.unused_days)); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Le réglage n’a pas pu être chargé."); });
    return () => { active = false; };
  }, []);

  const value = Number(draft);
  const valid = saved !== null && draft.trim() !== "" && Number.isInteger(value) && value >= saved.min && value <= saved.max;
  const changed = saved !== null && valid && value !== saved.unused_days;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!saved || !valid || pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      const next = await request("PUT", { unused_days: value, expected_revision: saved.revision });
      setSaved(next); setDraft(String(next.unused_days));
      setNotice("Réglage enregistré.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Le réglage n’a pas pu être enregistré.");
      request("GET").then(settings => { setSaved(settings); setDraft(String(settings.unused_days)); }).catch(() => undefined);
    } finally { setPending(false); }
  }

  return <section className="v2-settings-card" aria-labelledby="v2-reference-settings-heading">
    <h2 id="v2-reference-settings-heading">Produits connus par leur seul code-barres</h2>
    <p>Quand quelqu’un utilise un produit d’Open Food Facts absent du catalogue, une fiche ne contenant que son code-barres est créée pour y rattacher prix et paniers ; son nom et ses informations sont lus chez Open Food Facts par le navigateur. Une telle fiche sans rien de notre côté (ni prix, ni proposition, ni panier partagé, ni recette, ni signalement) est supprimée après le délai ci-dessous sans utilisation.</p>
    {saved === null ? (error ? <p className="v2-schedule-error" role="alert">{error}</p> : <p>Chargement…</p>) : <form onSubmit={save}>
      <div className="v2-schedule-fields">
        <label>Supprimer après (jours sans utilisation)
          <input type="number" inputMode="numeric" min={saved.min} max={saved.max} step={1} required value={draft}
            aria-describedby="v2-reference-settings-help" onChange={event => { setDraft(event.target.value); setNotice(""); }} />
        </label>
      </div>
      <p className="v2-settings-note" id="v2-reference-settings-help">
        Entre {saved.min} et {saved.max} ; 0 pour les garder toujours. {saved.count} fiche{saved.count > 1 ? "s" : ""} de ce type actuellement.
        Ouvrir sa page, la comparer dans un panier ou l’ajouter compte comme une utilisation. Le nettoyage passe chaque heure.
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
