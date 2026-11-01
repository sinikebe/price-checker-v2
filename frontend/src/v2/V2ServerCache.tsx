import { useEffect, useState } from "react";
import {
  diskLevel, diskPercent, formatBytes, getServerCache, lastRunSummary, momentLabel, requestCacheClean, type ServerCache,
} from "./v2-server-cache-api";
import "./v2-server-cache.css";

/** Administrator-only: what the server keeps on its disk, and a button to clean its cache. */
export default function V2ServerCache() {
  const [info, setInfo] = useState<ServerCache | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    getServerCache().then(value => { if (active) setInfo(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Chargement impossible."); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!info?.state) return;
    let active = true;
    const interval = window.setInterval(() => {
      getServerCache().then(value => {
        if (!active) return;
        setInfo(value);
        if (!value.state && value.last_run) {
          setNotice(value.last_run.result === "done" ? "Nettoyage terminé." : "Le nettoyage a échoué.");
        }
      }).catch(() => { /* the web server may answer 503 for a moment during an update */ });
    }, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [info?.state]);

  async function clean() {
    if (pending || !info?.scheduler_installed || info.state) return;
    setPending(true); setError(""); setNotice("");
    try {
      setInfo(await requestCacheClean());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Demande impossible.");
    } finally { setPending(false); }
  }

  const usage = info?.usage ?? null;
  const percent = usage ? diskPercent(usage.disk) : 0;
  return <section className="v2-settings-card v2-server-cache" aria-labelledby="v2-cache-heading">
    <h2 id="v2-cache-heading">Espace disque et cache</h2>
    <p>Chaque mise à jour laisse d’anciennes images et du cache de build sur le serveur. Le nettoyage les supprime ; il ne touche ni à la base de données ni aux sauvegardes.</p>
    {usage && <>
      <div className="v2-cache-disk">
        <div className="v2-cache-bar" role="meter" aria-label="Disque utilisé" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} data-level={diskLevel(percent)}>
          <span style={{ width: percent + "%" }} /></div>
        <p>{formatBytes(usage.disk.used_bytes)} utilisés sur {formatBytes(usage.disk.total_bytes)} ({percent} %) · {formatBytes(usage.disk.available_bytes)} libres</p>
      </div>
      <dl className="v2-cache-figures">
        <div><dt>Images de l’application</dt><dd>{formatBytes(usage.images.size_bytes)}<small>{usage.images.dangling
          ? `${usage.images.dangling} ancienne${usage.images.dangling > 1 ? "s" : ""} à supprimer` : "aucune ancienne image"}</small></dd></div>
        <div><dt>Cache de build</dt><dd>{formatBytes(usage.build_cache.size_bytes)}<small>réutilisé par les mises à jour</small></dd></div>
        <div><dt>Sauvegardes locales</dt><dd>{formatBytes(usage.backups.bytes)}<small>{usage.backups.count} fichier{usage.backups.count > 1 ? "s" : ""}, conservés 6 mois</small></dd></div>
      </dl>
      <p className="v2-settings-note">Mesures du {momentLabel(usage.at)}{usage.stale ? ". Elles datent un peu : le programme système les actualise toutes les six heures." : "."}</p>
    </>}
    {info && !usage && <p className="v2-settings-note">Les mesures de l’espace disque ne sont pas encore disponibles. Elles apparaissent au prochain passage du programme système.</p>}
    {info && <div className="v2-settings-actions">
      <button className="v2-button v2-button-secondary" type="button" onClick={() => void clean()}
        disabled={pending || !info.scheduler_installed || info.state !== null}>
        {info.state === "queued" ? "Nettoyage demandé" : info.state === "running" ? "Nettoyage en cours…" : "Nettoyer le cache"}
      </button>
    </div>}
    {info && !info.scheduler_installed && <p className="v2-settings-note">Le programme système n’est pas installé sur ce serveur : le nettoyage n’est pas disponible depuis cette page.</p>}
    {info?.state && <p className="v2-settings-note" role="status">{info.state === "queued"
      ? "Demande en attente du prochain contrôle (environ une minute)." : "Nettoyage en cours."}</p>}
    {info?.last_run && info.last_run.result !== "running" && <p className="v2-settings-note">{lastRunSummary(info.last_run)}</p>}
    {!info && !error && <p role="status">Chargement…</p>}
    {error && <p className="v2-schedule-error" role="alert">{error}</p>}
    {notice && <p className="v2-schedule-success" role="status">{notice}</p>}
  </section>;
}
