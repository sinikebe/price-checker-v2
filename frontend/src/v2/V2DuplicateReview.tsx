import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { moderationRequest } from "./v2-moderation-api";
import "./v2-duplicate-review.css";

type Kind = "product" | "store";
type Field = { key: string; origin: unknown; duplicate: unknown; suggested: unknown;
  state: "identical" | "one_sided" | "conflict" };
type Preview = { kind: Kind; origin_id: number; duplicate_id: number; origin_revision: number;
  duplicate_revision: number; origin_fingerprint: string; duplicate_fingerprint: string; fields: Field[];
  origin_retailer: string | null; duplicate_retailer: string | null };
type Detail = { report: { id: number; kind: Kind; content_id: number; reason: string;
  duplicate_id: number | null; duplicate_url: string | null }; origin: { id: number; data: Record<string,unknown>; retailer: string | null } };
type Candidate = { id: number; name: string; detail: string; code: string | null };
const labels: Record<string,string> = {
  name: "Nom", brand: "Marque", commercial_name: "Nom commercial", composition: "Composition",
  package: "Conditionnement", quantity: "Quantité", ean: "EAN / GTIN", group: "Groupe",
  tags: "Étiquettes", retailer_links: "Liens d’enseigne", notes: "Notes",
  nutriscore: "Nutri-Score", nova: "NOVA", nutriscore_version: "Version Nutri-Score",
  nutrition_checked_at: "Contrôle nutritionnel", off_source: "Source OFF",
  city: "Ville", postal_code: "Code postal", latitude: "Latitude", longitude: "Longitude",
  supports_drive: "Drive", supports_delivery: "Livraison", external_store_id: "Identifiant externe",
  osm_type: "Type OSM", osm_id: "Identifiant OSM",
};
function format(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Oui" : "Non";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
function editable(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}
function parse(value: string, sample: unknown): unknown {
  if (sample === null || sample === undefined) return value.trim() ? value : null;
  if (typeof sample === "boolean") return value === "true";
  if (typeof sample === "number") { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error("Nombre invalide."); return parsed; }
  if (typeof sample === "object" && sample !== null) return value.trim() ? JSON.parse(value) as unknown : null;
  return value;
}
function sheetUrl(kind: Kind, id: number) { return "/v2/" + (kind === "product" ? "produits" : "magasins") + "/" + id; }

export default function V2DuplicateReview({ reportId, onClose, onMerged }: {
  reportId: number; onClose: () => void; onMerged: () => void;
}) {
  const [detail,setDetail] = useState<Detail | null>(null);
  const [query,setQuery] = useState("");
  const [candidates,setCandidates] = useState<Candidate[]>([]);
  const [selected,setSelected] = useState<number | null>(null);
  const [candidateConfirmed,setCandidateConfirmed] = useState(false);
  const [preview,setPreview] = useState<Preview | null>(null);
  const [values,setValues] = useState<Record<string,string>>({});
  const [confirmed,setConfirmed] = useState<string[]>([]);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  useEffect(() => {
    let active=true;
    moderationRequest<Detail>("/reports/" + reportId + "/duplicate")
      .then(value => { if (active) { setDetail(value); setQuery(String(value.origin.data.name ?? value.origin.data.city ?? ""));
        if (value.report.duplicate_id) setSelected(value.report.duplicate_id); } })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active=false; };
  },[reportId]);
  useEffect(() => {
    if (!detail) return;
    let active=true;
    moderationRequest<Candidate[]>("/duplicate-candidates?kind=" + detail.report.kind + "&q=" + encodeURIComponent(query))
      .then(value => { if (active) setCandidates(value.filter(item => item.id !== detail.origin.id)); })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active=false; };
  },[detail,query]);
  useEffect(() => {
    if (!selected) return;
    let active=true;
    moderationRequest<Preview>("/reports/" + reportId + "/merge-preview?duplicate_id=" + selected)
      .then(value => { if (active) { setPreview(value); setValues(Object.fromEntries(value.fields.map(field => [field.key,editable(field.suggested)]))); } })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active=false; };
  },[reportId,selected]);
  const required = useMemo(() => preview?.fields.filter(field => field.state !== "identical") ?? [],[preview]);
  async function merge() {
    if (!preview || busy) return;
    setBusy(true); setError("");
    try {
      const result: Record<string,unknown> = {};
      for (const field of preview.fields) {
        const sample = field.origin ?? field.duplicate;
        result[field.key] = parse(values[field.key] ?? "",sample);
      }
      await moderationRequest("/reports/" + reportId + "/merge","POST",{
        duplicate_id: preview.duplicate_id, origin_revision: preview.origin_revision,
        duplicate_revision: preview.duplicate_revision, origin_fingerprint: preview.origin_fingerprint,
        duplicate_fingerprint: preview.duplicate_fingerprint, result, confirmed_fields: confirmed,
      });
      onMerged();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="v2-duplicate-review" aria-label="Examen du doublon">
    <div className="v2-duplicate-heading"><h2>Examiner le doublon #{reportId}</h2>
      <button type="button" onClick={onClose}>Fermer la vue</button></div>
    {error && <p role="alert">{error}</p>}
    {!detail && !error && <p>Chargement…</p>}
    {detail && <><p>{detail.report.reason}</p><div className="v2-duplicate-pair">
      <section className="v2-duplicate-pane"><h3>Fiche signalée · #{detail.origin.id}</h3>
        <p><Link to={sheetUrl(detail.report.kind,detail.origin.id)} target="_blank">Ouvrir la fiche ↗</Link></p>
        {detail.origin.retailer && <p>Enseigne source : {detail.origin.retailer}</p>}
        <dl>{Object.entries(detail.origin.data).filter(([,v]) => v !== null && v !== "")
          .map(([key,value]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{format(value)}</dd></div>)}</dl>
      </section>
      <section className="v2-duplicate-pane"><h3>Fiche doublon</h3>
        {detail.report.duplicate_url && <p>Lien indiqué : <code>{detail.report.duplicate_url}</code></p>}
        <label htmlFor="v2-duplicate-query">Rechercher par nom, marque, enseigne, ville, EAN ou ID</label>
        <input id="v2-duplicate-query" type="search" value={query} onChange={event => setQuery(event.target.value)} />
        <ul className="v2-duplicate-candidates">{candidates.map(item => <li key={item.id}>
          <button type="button" aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setCandidateConfirmed(false); setPreview(null); setConfirmed([]); setError(""); }}>
            #{item.id} · {item.name} <small>{item.detail} {item.code}</small></button>
          <Link to={sheetUrl(detail.report.kind,item.id)} target="_blank">Fiche ↗</Link>
        </li>)}</ul>
        {candidates.length === 0 && <p>Aucun résultat. Essayez l’ID ou un autre nom.</p>}
        {preview && <><p><strong>Fiche sélectionnée : #{preview.duplicate_id}</strong>
          {preview.duplicate_retailer && <> · Enseigne source : {preview.duplicate_retailer}</>}</p>
          <dl>{preview.fields.filter(field => field.duplicate !== null && field.duplicate !== "")
            .map(field => <div key={field.key}><dt>{labels[field.key] ?? field.key}</dt><dd>{format(field.duplicate)}</dd></div>)}</dl>
          <button type="button" className="v2-button v2-button-primary" onClick={() => setCandidateConfirmed(true)}
            disabled={candidateConfirmed}>{candidateConfirmed ? "Doublon confirmé ✓" : "Confirmer ce doublon"}</button></>}
      </section>
    </div>
    {preview && candidateConfirmed && <section className="v2-duplicate-result"><h3>Fiche résultante · #{preview.origin_id}</h3>
      <p>Rouge : conflit à résoudre manuellement. Orange : valeur préremplie à valider d’un clic. Les champs identiques ne demandent aucune action.</p>
      <div className="v2-duplicate-fields">{preview.fields.map(field => {
        const different = field.state !== "identical";
        const checked = confirmed.includes(field.key);
        const sample = field.origin ?? field.duplicate;
        return <div className={"v2-duplicate-field v2-duplicate-" + field.state} key={field.key}>
          <div><strong>{labels[field.key] ?? field.key}</strong>{different && <span className="v2-duplicate-state">{field.state === "conflict" ? "Conflit" : "Complément"}</span>}</div>
          {different && <p>Fiche signalée : {format(field.origin)} · Doublon : {format(field.duplicate)}</p>}
          {different ? <div className="v2-duplicate-edit">
            {typeof sample === "boolean" ? <select aria-label={labels[field.key] ?? field.key} value={values[field.key] ?? "false"}
              onChange={event => { setValues({...values,[field.key]:event.target.value}); setConfirmed(confirmed.filter(key => key !== field.key)); }}>
              <option value="false">Non</option><option value="true">Oui</option></select>
              : <textarea aria-label={labels[field.key] ?? field.key} value={values[field.key] ?? ""} rows={typeof sample === "object" ? 3 : 1}
                onChange={event => { setValues({...values,[field.key]:event.target.value}); setConfirmed(confirmed.filter(key => key !== field.key)); }} />}
            <button type="button" aria-pressed={checked} onClick={() => setConfirmed(checked ? confirmed.filter(key => key !== field.key) : [...confirmed,field.key])}>
              {checked ? "Validé ✓" : field.state === "conflict" ? "Résoudre ce conflit" : "Valider cette valeur"}</button>
          </div> : <p>{format(field.origin)}</p>}
        </div>;
      })}</div>
      <button type="button" className="v2-button v2-button-primary" disabled={busy || required.some(field => !confirmed.includes(field.key))}
        onClick={() => { void merge(); }}>Fusionner les fiches</button>
    </section>}
    </>}
  </section>;
}
