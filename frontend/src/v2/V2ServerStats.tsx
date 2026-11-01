import { useEffect, useState } from "react";
import {
  CONTRIBUTION_LABELS, GROUP_LABELS, PAGE_LABELS, STATS_PERIODS, formatCount, formatRate, getStats, partialPeriod, sortEndpoints,
  type EndpointSort, type Stats, type StatsPeriod,
} from "./v2-stats-api";
import "./v2-observability.css";

const day = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const COLUMNS: { id: EndpointSort; label: string }[] = [
  { id: "requests", label: "Requêtes" }, { id: "per_hour", label: "Par heure" }, { id: "errors", label: "Erreurs" }, { id: "average_ms", label: "Durée moyenne" },
];
const SUMMARY = ["basket", "prices", "products", "catalogue"];

/** Administrator-only: numbers per endpoint, per kind of contribution and per page. No personal data. */
export default function V2ServerStats({ active }: { active: boolean }) {
  const [period, setPeriod] = useState<StatsPeriod>("24h");
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ key: string; stats?: Stats; error?: string } | null>(null);
  const [sort, setSort] = useState<EndpointSort>("requests");
  const key = `${period}:${tick}`;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    getStats(period, controller.signal)
      .then(stats => { if (!controller.signal.aborted) setResult({ key, stats }); })
      .catch(reason => { if (!controller.signal.aborted) setResult({ key, error: reason instanceof Error ? reason.message : "Chargement impossible." }); });
    return () => controller.abort();
  }, [active, key, period]);

  const stats = result?.stats;
  const loading = !result || result.key !== key;
  const endpoints = stats ? sortEndpoints(stats.endpoints, sort) : [];
  return <section className="v2-settings-card v2-observability v2-stats" aria-labelledby="v2-stats-heading">
    <h2 id="v2-stats-heading">Statistiques</h2>
    <p>Des nombres, rien d’autre : les requêtes par point d’accès, les contributions, les pages vues et les comptes créés. Aucune adresse, aucun compte ni aucune URL n’est enregistré. Une visite est le premier affichage d’une page dans un onglet du navigateur ; ce n’est pas un nombre de personnes.</p>
    <div className="v2-stats-toolbar">
      <div className="v2-logs-chips" role="group" aria-label="Période">{STATS_PERIODS.map(item => <button key={item.id} type="button" className="v2-logs-chip"
        aria-pressed={period === item.id} onClick={() => setPeriod(item.id)}>{item.label}</button>)}</div>
      <button type="button" className="v2-button v2-button-secondary" onClick={() => setTick(value => value + 1)} disabled={loading}>Actualiser</button>
    </div>
    {result?.error && <p className="v2-schedule-error" role="alert">{result.error}</p>}
    {loading && !result?.error && <p role="status">Chargement…</p>}
    {stats && <>
      {partialPeriod(stats) && <p className="v2-settings-note">Les compteurs de requêtes et de pages ont commencé {stats.recording_since ? `le ${day(stats.recording_since)}` : "à l’instant"} : cette période est incomplète. Les contributions et les comptes, eux, couvrent toute la période.</p>}
      <div className="v2-stats-cards">
        {SUMMARY.map(group => <div key={group} className="v2-stats-card"><span>Requêtes {GROUP_LABELS[group].toLowerCase()}</span>
          <strong>{formatCount(stats.groups[group]?.requests ?? 0)}</strong><small>{formatCount(stats.groups[group]?.errors ?? 0)} en erreur</small></div>)}
        <div className="v2-stats-card"><span>Toutes les requêtes</span><strong>{formatCount(stats.requests.total)}</strong>
          <small>{formatCount(stats.requests.client_errors)} refusées, {formatCount(stats.requests.server_errors)} en échec</small></div>
        <div className="v2-stats-card"><span>Visites</span><strong>{formatCount(stats.traffic.visits)}</strong><small>{formatCount(stats.traffic.page_views)} pages vues</small></div>
        <div className="v2-stats-card"><span>Comptes créés</span><strong>{formatCount(stats.traffic.accounts_created)}</strong></div>
      </div>
      <h3>Points d’accès</h3>
      <div className="v2-stats-scroll"><table className="v2-stats-table v2-stats-endpoints">
        <thead><tr><th scope="col">Point d’accès</th>{COLUMNS.map(column => <th key={column.id} scope="col" aria-sort={sort === column.id ? "descending" : "none"}>
          <button type="button" onClick={() => setSort(column.id)}>{column.label}</button></th>)}</tr></thead>
        <tbody>{endpoints.length ? endpoints.map(item => <tr key={item.method + item.route}>
          <th scope="row"><span className="v2-stats-method">{item.method}</span> {item.route}</th>
          <td>{formatCount(item.requests)}</td><td>{formatRate(item.per_hour)}</td>
          <td>{formatCount(item.client_errors + item.server_errors)}</td><td>{formatCount(item.average_ms)} ms</td></tr>)
          : <tr><td colSpan={5}>Aucune requête sur cette période.</td></tr>}</tbody></table></div>
      <div className="v2-stats-columns">
        <div><h3>Contributions</h3><table className="v2-stats-table"><tbody>{Object.entries(CONTRIBUTION_LABELS).map(([id, label]) =>
          <tr key={id}><th scope="row">{label}</th><td>{formatCount(stats.contributions[id] ?? 0)}</td></tr>)}</tbody></table></div>
        <div><h3>Pages vues</h3><table className="v2-stats-table"><thead><tr><th scope="col">Page</th><th scope="col">Vues</th><th scope="col">Visites</th></tr></thead>
          <tbody>{stats.traffic.pages.length ? stats.traffic.pages.map(page => <tr key={page.page}><th scope="row">{PAGE_LABELS[page.page] ?? page.page}</th>
            <td>{formatCount(page.views)}</td><td>{formatCount(page.visits)}</td></tr>) : <tr><td colSpan={3}>Aucune page vue sur cette période.</td></tr>}</tbody></table></div>
      </div>
    </>}
  </section>;
}
