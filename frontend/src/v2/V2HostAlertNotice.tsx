import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getHealth, metricNames, type Alert } from "./v2-host-health-api";

export default function V2HostAlertNotice({ userId }: { userId: number }) {
  const key = `v2:host-alerts:seen:${userId}`;
  const [alerts, setAlerts] = useState<Alert[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getHealth().then(health => {
        if (!active || !health.available) return;
        let seen = "";
        try { seen = window.localStorage.getItem(key) ?? ""; } catch { /* Alerts remain visible. */ }
        const unseen = health.alerts.filter(alert => alert.at > seen);
        const latest = new Map(unseen.map(alert => [alert.metric, alert]));
        setAlerts([...latest.values()]);
      }).catch(() => { /* Status remains available in settings. */ });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [key]);
  if (!alerts.length) return null;
  const newest = alerts.reduce((value, alert) => alert.at > value ? alert.at : value, "");
  function dismiss() {
    try { window.localStorage.setItem(key, newest); } catch { /* Dismiss this view anyway. */ }
    setAlerts([]);
  }
  return <aside className="v2-host-alert-notice" role="alert">
    <strong>Ressources du serveur au-dessus de 80 % :</strong> {alerts.map(alert =>
      `${metricNames[alert.metric]} ${alert.pct.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`).join(" · ")}
    <Link to="/v2/parametres/serveur">Voir les mesures</Link>
    <button type="button" onClick={dismiss} aria-label="Fermer l’alerte des ressources">Fermer</button>
  </aside>;
}
