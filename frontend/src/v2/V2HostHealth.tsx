import { useEffect, useState } from "react";

import { getHealth, metricNames, type Health } from "./v2-host-health-api";

const percent = (value: number | null) => value === null ? "—" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;
const size = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Gio`;
const date = (value: string) => new Date(value).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

function Summary({ label, value, average, maximum }: { label: string; value: number | null;
  average: number | null; maximum: number | null }) {
  return <div className="v2-health-metric">
    <strong>{label}</strong><b className={value !== null && value > 80 ? "v2-health-high" : ""}>{percent(value)}</b>
    <span>24 h : moy. {percent(average)} · max. {percent(maximum)}</span>
  </div>;
}

export default function V2HostHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => { void getHealth().then(data => { if (active) { setHealth(data); setError(""); } })
      .catch(() => { if (active) setError("Les mesures de l’hôte ne sont pas disponibles."); }); };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const hours = health?.available ? health.hourly : [];
  const cpuCount = hours.reduce((total, point) => total + point.cpu_samples, 0);
  const sampleCount = hours.reduce((total, point) => total + point.samples, 0);
  const cpuAverage = cpuCount ? hours.reduce((total, point) => total + (point.cpu_avg ?? 0) * point.cpu_samples, 0) / cpuCount : null;
  const memoryAverage = sampleCount ? hours.reduce((total, point) => total + point.memory_avg * point.samples, 0) / sampleCount : null;
  const cpuMaximum = cpuCount ? Math.max(...hours.map(point => point.cpu_max ?? 0)) : null;
  const memoryMaximum = sampleCount ? Math.max(...hours.map(point => point.memory_max)) : null;
  return <section className="v2-settings-card v2-host-health" aria-labelledby="v2-health-heading">
    <h2 id="v2-health-heading">État de l’hôte</h2>
    <p>Vue indicative des ressources du serveur. Une mesure par minute est résumée en 24 points horaires.</p>
    {error && <p role="alert" className="v2-schedule-error">{error}</p>}
    {!health && !error && <p role="status">Chargement des mesures…</p>}
    {health && !health.available && <p>La surveillance de l’hôte n’est pas encore installée sur ce serveur.</p>}
    {health?.available && <>
      {health.stale && <p role="alert" className="v2-schedule-error">Les mesures ne sont plus actualisées. Vérifiez le service de surveillance.</p>}
      <div className="v2-health-summary">
        <Summary label="Processeur" value={health.current.cpu_pct} average={cpuAverage} maximum={cpuMaximum} />
        <Summary label="Mémoire" value={health.current.memory.pct} average={memoryAverage} maximum={memoryMaximum} />
        <div className="v2-health-metric"><strong>Stockage de l’hôte</strong>
          <b className={health.current.disk.pct > 80 ? "v2-health-high" : ""}>{percent(health.current.disk.pct)}</b>
          <span>{size(health.current.disk.used_bytes)} utilisés · {size(health.current.disk.available_bytes)} libres</span></div>
      </div>
      <p className="v2-settings-note">Dernier relevé : {date(health.updated_at)}. Seuls les points des 24 dernières heures sont conservés.</p>
      {health.alerts.length > 0 && <div className="v2-health-alerts" role="status" aria-live="polite">
        <h3>Alertes des dernières 24 heures</h3>
        <ul>{health.alerts.slice().reverse().map(alert => <li key={`${alert.metric}-${alert.at}`}>
          {metricNames[alert.metric]} : {percent(alert.pct)} le {date(alert.at)}
        </li>)}</ul>
        <p className="v2-settings-note">Au-delà de 80 %, au maximum une alerte par ressource et par heure.</p>
      </div>}
      {hours.length > 0 && <details className="v2-health-details"><summary>Voir les relevés horaires</summary>
        <div className="v2-health-table-scroll"><table><thead><tr><th>Heure</th><th>CPU moy.</th><th>CPU max.</th><th>RAM moy.</th><th>RAM max.</th><th>Disque</th></tr></thead>
          <tbody>{hours.slice().reverse().map(point => <tr key={point.hour}><th>{date(point.hour)}</th>
            <td>{percent(point.cpu_avg)}</td><td>{percent(point.cpu_max)}</td>
            <td>{percent(point.memory_avg)}</td><td>{percent(point.memory_max)}</td><td>{percent(point.disk_pct)}</td>
          </tr>)}</tbody></table></div>
      </details>}
    </>}
  </section>;
}
