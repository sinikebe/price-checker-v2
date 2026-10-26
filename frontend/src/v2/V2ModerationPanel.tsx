import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { moderationRequest } from "./v2-moderation-api";

type Report = {
  id: number; kind: "product" | "recipe"; content_id: number;
  reason: string; reporter: string; created_at: string;
};
const PAGE_SIZE = 30;

export default function V2ModerationPanel() {
  const [page, setPage] = useState(0);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    moderationRequest<Report[]>("/reports?limit=" + PAGE_SIZE + "&offset=" + (page * PAGE_SIZE))
      .then(rows => { if (active) { setReports(rows); setError(""); } })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [page, reload]);
  async function resolve(report: Report, action: "dismiss" | "withdraw") {
    if (action === "withdraw" && !window.confirm("Retirer ce contenu public et ses vues associées ?")) return;
    setBusy(report.id); setError("");
    try {
      await moderationRequest("/reports/" + report.id + "/resolve", "POST", { action });
      setReload(value => value + 1);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(null); }
  }
  return <section className="v2-settings-card" aria-labelledby="v2-reports-heading">
    <h2 id="v2-reports-heading">Signalements à examiner</h2>
    {error && <p role="alert">{error}</p>}
    {!reports && !error && <p>Chargement…</p>}
    {reports?.length === 0 && <p>Aucun signalement ouvert.</p>}
    {reports?.map(report => <article key={report.id}>
      <p><Link to={report.kind === "product" ? "/v2/produits/" + report.content_id : "/v2/recettes/" + report.content_id}>
        {report.kind === "product" ? "Produit" : "Recette"} #{report.content_id}</Link>
        {" · "}{report.reporter} · {new Date(report.created_at).toLocaleString("fr-FR")}</p>
      <p>{report.reason}</p>
      <div className="v2-settings-actions">
        <button type="button" className="v2-button v2-button-secondary" disabled={busy !== null}
          onClick={() => { void resolve(report, "dismiss"); }}>Classer sans suite</button>
        <button type="button" className="v2-button v2-button-secondary" disabled={busy !== null}
          onClick={() => { void resolve(report, "withdraw"); }}>Retirer le contenu</button>
      </div>
    </article>)}
    {reports && (page > 0 || reports.length === PAGE_SIZE) && <div className="v2-settings-actions">
      <button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Précédent</button>
      <span>Page {page + 1}</span>
      <button type="button" disabled={reports.length < PAGE_SIZE} onClick={() => setPage(value => value + 1)}>Suivant</button>
    </div>}
  </section>;
}
