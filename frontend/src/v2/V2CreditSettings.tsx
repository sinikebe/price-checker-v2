import { useEffect, useState, type FormEvent } from "react";
import V2Info from "./V2Info";
import { CREDIT_FIELDS, creditSummary, loadCreditSettings, readAmounts, saveCreditSettings, type CreditAmounts, type CreditSettings } from "./v2-credit-settings";
import { errorText } from "./v2-http";

type Draft = Record<keyof CreditAmounts, string>;
const draftOf = (settings: CreditSettings): Draft =>
  Object.fromEntries(CREDIT_FIELDS.map(({ key }) => [key, String(settings[key])])) as Draft;

/** Administrator settings: the credits that pay for seeing prices. */
export default function V2CreditSettings() {
  const [saved, setSaved] = useState<CreditSettings | null>(null);
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(CREDIT_FIELDS.map(({ key }) => [key, ""])) as Draft);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    loadCreditSettings()
      .then(settings => { if (active) { setSaved(settings); setDraft(draftOf(settings)); } })
      .catch(reason => { if (active) setError(errorText(reason, "Les réglages n’ont pas pu être chargés.")); });
    return () => { active = false; };
  }, []);

  const amounts = saved ? readAmounts(draft, saved) : null;
  const valid = amounts !== null && !("invalid" in amounts);
  const changed = valid && saved !== null && CREDIT_FIELDS.some(({ key }) => (amounts as CreditAmounts)[key] !== saved[key]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!saved || !valid || pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      const next = await saveCreditSettings(amounts as CreditAmounts, saved.revision);
      setSaved(next); setDraft(draftOf(next));
      setNotice("Réglages enregistrés. Ils s’appliquent dès la prochaine attribution de crédits.");
    } catch (reason) {
      setError(errorText(reason, "Les réglages n’ont pas pu être enregistrés."));
      loadCreditSettings().then(settings => { setSaved(settings); setDraft(draftOf(settings)); }).catch(() => undefined);
    } finally { setPending(false); }
  }

  const invalidField = amounts && "invalid" in amounts ? CREDIT_FIELDS.find(field => field.key === amounts.invalid) : undefined;
  return <section className="v2-settings-card v2-credit-settings" aria-labelledby="v2-credit-settings-heading">
    <h2 id="v2-credit-settings-heading">Crédits pour voir les prix <V2Info>Chaque prix affiché coûte des crédits, pour éviter qu’un robot lise tout le catalogue. Les contributions validées rapportent des crédits de contribution, sans limite ni expiration. Les administrateurs ne sont pas comptés.</V2Info></h2>
    {saved === null ? (error ? <p className="v2-schedule-error" role="alert">{error}</p> : <p>Chargement…</p>) : <form onSubmit={save}>
      <div className="v2-schedule-fields">
        {CREDIT_FIELDS.map(field => <label key={field.key}>{field.label}
          <input type="number" inputMode="numeric" min={saved.bounds[field.key].min} max={saved.bounds[field.key].max} step={1} required
            value={draft[field.key]} aria-describedby={`v2-credit-${field.key}-help`}
            onChange={event => { setDraft(current => ({ ...current, [field.key]: event.target.value })); setNotice(""); }} />
          <small id={`v2-credit-${field.key}-help`}>{field.help} Entre {saved.bounds[field.key].min} et {saved.bounds[field.key].max}.</small>
        </label>)}
      </div>
      {valid && <p className="v2-settings-note">{creditSummary(amounts as CreditAmounts)}</p>}
      <div className="v2-settings-actions">
        <button type="submit" className="v2-button v2-button-primary" disabled={!changed || pending}>{pending ? "Enregistrement…" : "Enregistrer"}</button>
      </div>
      {invalidField && <p className="v2-schedule-error" role="alert">{invalidField.label} : un nombre entier entre {saved.bounds[invalidField.key].min} et {saved.bounds[invalidField.key].max}.</p>}
      {error && <p className="v2-schedule-error" role="alert">{error}</p>}
      {notice && <p className="v2-schedule-success" role="status">{notice}</p>}
    </form>}
  </section>;
}
