import { useEffect, useState, type FormEvent } from "react";
import { loadRecheckSettings, recheckSummary, saveRecheckSettings, type RecheckSettings } from "./v2-availability";

/** Administrator setting: how long a product withdrawn from a store's range is left alone. */
export default function V2AvailabilitySettings() {
  const [saved, setSaved] = useState<RecheckSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    loadRecheckSettings()
      .then(settings => { if (active) { setSaved(settings); setDraft(String(settings.recheck_days)); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Le réglage n’a pas pu être chargé."); });
    return () => { active = false; };
  }, []);

  const value = Number(draft);
  const valid = saved !== null && draft.trim() !== "" && Number.isInteger(value) && value >= saved.min && value <= saved.max;
  const changed = saved !== null && valid && value !== saved.recheck_days;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!saved || !valid || pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      const next = await saveRecheckSettings(value, saved.revision);
      setSaved(next); setDraft(String(next.recheck_days));
      setNotice("Réglage enregistré.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Le réglage n’a pas pu être enregistré.");
      loadRecheckSettings().then(settings => { setSaved(settings); setDraft(String(settings.recheck_days)); }).catch(() => undefined);
    } finally { setPending(false); }
  }

  return <section className="v2-settings-card v2-availability-settings" aria-labelledby="v2-availability-settings-heading">
    <h2 id="v2-availability-settings-heading">Produits retirés de la gamme</h2>
    <p>Quand un magasin ne vend plus un produit, seul ce magasin est concerné : le produit et ses autres prix restent en place. Le connecteur ne relit plus cette page à chaque cycle de fraîcheur ; il y revient après le délai ci-dessous, ou dès qu’un prix plus récent y est relevé.</p>
    {saved === null ? (error ? <p className="v2-schedule-error" role="alert">{error}</p> : <p>Chargement…</p>) : <form onSubmit={save}>
      <div className="v2-schedule-fields">
        <label>Délai avant de revérifier (jours)
          <input type="number" inputMode="numeric" min={saved.min} max={saved.max} step={1} required value={draft}
            aria-describedby="v2-availability-settings-help" onChange={event => { setDraft(event.target.value); setNotice(""); }} />
        </label>
      </div>
      <p className="v2-settings-note" id="v2-availability-settings-help">
        Entre {saved.min} et {saved.max} ; 0 pour ne jamais revérifier seul. {recheckSummary(saved.recheck_days)} Sur la page d’un produit, un administrateur peut aussi demander une nouvelle vérification d’un magasin.
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
