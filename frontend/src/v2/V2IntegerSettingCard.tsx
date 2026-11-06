import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorText } from "./v2-http";

/**
 * Administrator setting held in one whole number between the server's bounds, saved with the revision
 * it was read at: a change made meanwhile elsewhere is refused, and the card then reloads the value.
 * `load` and `read` are module-level functions: a new copy would reload the value on each render.
 */
export default function V2IntegerSettingCard<S extends { revision: number; min: number; max: number }>({ name, className, title, intro, label, read, load, save, note }: {
  name: string;
  className?: string;
  title: string;
  intro: string;
  label: string;
  read: (settings: S) => number;
  load: () => Promise<S>;
  save: (value: number, revision: number) => Promise<S>;
  note: (settings: S) => ReactNode;
}) {
  const [saved, setSaved] = useState<S | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    load()
      .then(settings => { if (active) { setSaved(settings); setDraft(String(read(settings))); } })
      .catch(reason => { if (active) setError(errorText(reason, "Le réglage n’a pas pu être chargé.")); });
    return () => { active = false; };
  }, [load, read]);

  const value = Number(draft);
  const valid = saved !== null && draft.trim() !== "" && Number.isInteger(value) && value >= saved.min && value <= saved.max;
  const changed = saved !== null && valid && value !== read(saved);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!saved || !valid || pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      const next = await save(value, saved.revision);
      setSaved(next); setDraft(String(read(next)));
      setNotice("Réglage enregistré.");
    } catch (reason) {
      setError(errorText(reason, "Le réglage n’a pas pu être enregistré."));
      load().then(settings => { setSaved(settings); setDraft(String(read(settings))); }).catch(() => undefined);
    } finally { setPending(false); }
  }

  const headingId = `v2-${name}-heading`;
  const helpId = `v2-${name}-help`;
  return <section className={className ? "v2-settings-card " + className : "v2-settings-card"} aria-labelledby={headingId}>
    <h2 id={headingId}>{title}</h2>
    <p>{intro}</p>
    {saved === null ? (error ? <p className="v2-schedule-error" role="alert">{error}</p> : <p>Chargement…</p>) : <form onSubmit={submit}>
      <div className="v2-schedule-fields">
        <label>{label}
          <input type="number" inputMode="numeric" min={saved.min} max={saved.max} step={1} required value={draft}
            aria-describedby={helpId} onChange={event => { setDraft(event.target.value); setNotice(""); }} />
        </label>
      </div>
      <p className="v2-settings-note" id={helpId}>{note(saved)}</p>
      <div className="v2-settings-actions">
        <button type="submit" className="v2-button v2-button-primary" disabled={!changed || pending}>{pending ? "Enregistrement…" : "Enregistrer"}</button>
      </div>
      {!valid && draft.trim() !== "" && <p className="v2-schedule-error" role="alert">Saisissez un nombre entier entre {saved.min} et {saved.max}.</p>}
      {error && <p className="v2-schedule-error" role="alert">{error}</p>}
      {notice && <p className="v2-schedule-success" role="status">{notice}</p>}
    </form>}
  </section>;
}
