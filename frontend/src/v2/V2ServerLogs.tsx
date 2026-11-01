import { useEffect, useState } from "react";
import { describeLog } from "./v2-log-events";
import {
  LEVELS, PERIODS, SOURCES, defaultLogFilters, getLogs, type LogFilters, type LogItem, type LogLevel, type LogPage, type LogPeriod, type LogSource,
} from "./v2-logs-api";
import "./v2-observability.css";

const moment = (iso: string) => new Date(iso).toLocaleString("fr-FR", {
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const levelLabel = (id: LogLevel) => LEVELS.find(level => level.id === id)?.label ?? id;
const sourceLabel = (id: LogSource) => SOURCES.find(source => source.id === id)?.label ?? id;

type First = { key: string; page?: LogPage; error?: string };
type More = { key: string; items: LogItem[]; next: string | null };

/** Administrator-only: the operational journal, with level, source, connector and period filters. */
export default function V2ServerLogs({ active }: { active: boolean }) {
  const [filters, setFilters] = useState<LogFilters>(defaultLogFilters);
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  const [first, setFirst] = useState<First | null>(null);
  const [more, setMore] = useState<More | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const key = JSON.stringify(filters) + ":" + tick;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    getLogs(filters, null, controller.signal)
      .then(page => { if (!controller.signal.aborted) setFirst({ key, page }); })
      .catch(reason => { if (!controller.signal.aborted) setFirst({ key, error: reason instanceof Error ? reason.message : "Chargement impossible." }); });
    return () => controller.abort();
  }, [active, key, filters]);

  useEffect(() => {
    if (!active || !live) return;
    const interval = window.setInterval(() => setTick(value => value + 1), 10_000);
    return () => window.clearInterval(interval);
  }, [active, live]);

  const loaded = first?.page;
  const extra = more && first && more.key === first.key ? more : null;
  const items = loaded ? [...loaded.items, ...(extra?.items ?? [])] : [];
  const next = extra ? extra.next : loaded?.next_before ?? null;
  const loading = !first || first.key !== key;
  const change = (patch: Partial<LogFilters>) => { setMore(null); setMoreError(""); setFilters({ ...filters, ...patch }); };
  const toggleSource = (source: LogSource) => change({
    sources: filters.sources.includes(source) ? filters.sources.filter(item => item !== source) : [...filters.sources, source],
    connector: "",
  });

  async function loadMore() {
    if (!next || !first || loadingMore) return;
    setLoadingMore(true); setMoreError("");
    try {
      const page = await getLogs(filters, next);
      setMore({ key: first.key, items: [...(extra?.items ?? []), ...page.items], next: page.next_before });
    } catch (reason) {
      setMoreError(reason instanceof Error ? reason.message : "Chargement impossible.");
    } finally { setLoadingMore(false); }
  }

  const counts = loaded?.counts ?? {};
  const showConnector = !!loaded?.connectors.length && (!filters.sources.length || filters.sources.includes("connector"));
  return <section className="v2-settings-card v2-observability v2-logs" aria-labelledby="v2-logs-heading">
    <h2 id="v2-logs-heading">Journal du serveur</h2>
    <p>Les événements du système (mises à jour, nettoyage, alertes de l’hôte), des connecteurs (file d’attente, prix enregistrés) et du panier. Le journal ne contient que des codes d’événements et des nombres : jamais de nom, d’adresse ni de contenu saisi. Il est conservé 30 jours.</p>
    <div className="v2-logs-filters">
      <label>Niveau minimum
        <select value={filters.level} onChange={event => change({ level: event.target.value as LogLevel })}>
          {LEVELS.map(level => <option key={level.id} value={level.id}>{level.label}</option>)}</select></label>
      <fieldset><legend>Sources</legend>
        <div className="v2-logs-chips">{SOURCES.map(source => <button key={source.id} type="button" className="v2-logs-chip"
          aria-pressed={filters.sources.includes(source.id)} onClick={() => toggleSource(source.id)}>{source.label}</button>)}</div></fieldset>
      {showConnector && <label>Connecteur
        <select value={filters.connector} onChange={event => change({ connector: event.target.value })}>
          <option value="">Tous</option>{loaded!.connectors.map(id => <option key={id} value={id}>{id}</option>)}</select></label>}
      <label>Période
        <select value={filters.period} onChange={event => change({ period: event.target.value as LogPeriod })}>
          {PERIODS.map(period => <option key={period.id} value={period.id}>{period.label}</option>)}</select></label>
      <div className="v2-logs-actions">
        <button type="button" className="v2-button v2-button-secondary" onClick={() => { setMore(null); setTick(value => value + 1); }} disabled={loading}>Actualiser</button>
        <label className="v2-logs-live"><input type="checkbox" checked={live} onChange={event => setLive(event.target.checked)} />Suivi en direct (10 s)</label>
      </div>
    </div>
    {loaded && <p className="v2-settings-note" role="status">Sur cette période : {[["error", "erreur", "erreurs"], ["warning", "alerte", "alertes"], ["info", "information", "informations"], ["debug", "détail", "détails"]]
      .map(([id, one, many]) => `${counts[id as LogLevel] ?? 0} ${(counts[id as LogLevel] ?? 0) > 1 ? many : one}`).join(", ")}.</p>}
    {first?.error && <p className="v2-schedule-error" role="alert">{first.error}</p>}
    {loading && !first?.error && <p role="status">Chargement…</p>}
    {loaded && !items.length && !loading && <p className="v2-settings-note">Aucun événement pour ces filtres.</p>}
    {items.length > 0 && <ol className="v2-log-list" aria-busy={loading}>{items.map(item => <li key={item.id} className="v2-log" data-level={item.level}>
      <time dateTime={item.at}>{moment(item.at)}</time>
      <span className="v2-log-level">{levelLabel(item.level)}</span>
      <span className="v2-log-source">{sourceLabel(item.source)}{item.connector ? ` · ${item.connector}` : ""}</span>
      <span className="v2-log-text">{describeLog(item)}</span></li>)}</ol>}
    {next && <div className="v2-settings-actions"><button type="button" className="v2-button v2-button-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
      {loadingMore ? "Chargement…" : "Afficher les événements plus anciens"}</button></div>}
    {moreError && <p className="v2-schedule-error" role="alert">{moreError}</p>}
  </section>;
}
