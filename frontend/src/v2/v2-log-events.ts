import type { LogItem } from "./v2-logs-api";

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;
const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const bytes = (value: number) => value < 1000 ? `${value} o` : value < 1e6 ? `${Math.round(value / 1e3)} ko`
  : value < 1e9 ? `${(value / 1e6).toFixed(1).replace(".", ",")} Mo` : `${(value / 1e9).toFixed(1).replace(".", ",")} Go`;
const number = (value: unknown) => typeof value === "number" ? value : 0;
const text = (value: unknown) => typeof value === "string" ? value : "";

const ORIGIN: Record<string, string> = { basket: "panier", single: "fiche produit", page: "page de prix" };
const CHANNEL: Record<string, string> = { in_store: "en magasin", drive: "drive", delivery: "livraison" };
const METRIC: Record<string, string> = { cpu: "processeur", memory: "mémoire", disk: "stockage" };
const UPDATE_REASON: Record<string, string> = {
  ci_not_passed: "la CI n’a pas validé la version", not_fast_forward: "la branche ne progresse pas en ligne droite",
  interrupted: "mise à jour interrompue", update_failed: "le script de mise à jour a échoué", other: "cause non précisée",
};
const DROPPED: Record<string, string> = {
  fresh_elsewhere: "un prix récent est arrivé d’une autre source", cooldown: "déjà lu au cours des dernières 24 h", unavailable: "connecteur indisponible",
};
const READING: Record<string, string> = {
  complete: "terminée", skipped: "ignorée, le prix était déjà récent", rejected: "page refusée", failed: "échec",
  discontinued: "produit retiré de la gamme du magasin", not_found: "produit absent du catalogue de l’enseigne",
};

const HTTP_MEANING: Record<number, string> = { 401: "accès refusé", 403: "accès refusé", 404: "introuvable", 429: "trop de requêtes" };
// What a Python exception class usually means for a connector; anything else is shown by its class name.
function errorMeaning(error: string): string {
  if (/timeout/i.test(error)) return "délai dépassé";
  if (/connect|gaierror|network|dns|ssl|socket|resolve/i.test(error)) return "connexion impossible";
  if (/target.?closed|browser|playwright|page.?crash/i.test(error)) return "navigateur";
  if (/privilege|undefined(table|column)|postgres|asyncpg|integrity|unique|dataerror|interface/i.test(error)) return "base de données";
  if (/json|decode|parse|key|value|attribute|type|index/i.test(error)) return "page ou réponse inattendue";
  return "erreur inattendue";
}

/** The sentence for an event, built from its code and numbers: the server stores no text. */
export function describeLog(item: LogItem): string {
  const d = item.data;
  switch (item.event) {
    case "system.started": return `Serveur démarré (version ${text(d.version)}).`;
    case "system.migrated": return `${plural(number(d.count), "migration appliquée", "migrations appliquées")} (dernière : ${text(d.latest)}).`;
    case "update.finished": {
      const how = d.trigger === "manual" ? "demandée" : "planifiée";
      if (d.result === "updated") return `Mise à jour ${how} : ${text(d.from_sha).slice(0, 7) || "?"} → ${text(d.to_sha).slice(0, 7) || "?"}.`;
      if (d.result === "current") return `Mise à jour ${how} : le serveur était déjà à jour.`;
      return `Mise à jour ${how} échouée : ${UPDATE_REASON[text(d.reason)] ?? UPDATE_REASON.other}.`;
    }
    case "cache.cleaned": {
      const how = d.trigger === "update" ? "après une mise à jour" : "demandé depuis les paramètres";
      return d.result === "done" ? `Nettoyage du cache (${how}) : ${typeof d.freed_bytes === "number" ? `${bytes(d.freed_bytes)} libérés` : "terminé"}.`
        : `Nettoyage du cache (${how}) : échec.`;
    }
    case "host.alert": return `Alerte de l’hôte : ${METRIC[text(d.metric)] ?? text(d.metric)} à ${number(d.pct)} %.`;
    case "connector.queue.requested": {
      const parts = [[d.queued, "ajouté", "ajoutés"], [d.fresh, "déjà à jour", "déjà à jour"], [d.cooldown, "en délai d’attente", "en délai d’attente"],
        [d.rate_limited, "limité", "limités"], [d.other, "autre", "autres"]] as const;
      const detail = parts.filter(([count]) => number(count) > 0).map(([count, one, many]) => plural(number(count), one, many)).join(", ");
      return `File d’attente (${ORIGIN[text(d.origin)] ?? text(d.origin)}) : ${plural(number(d.requested), "produit demandé", "produits demandés")}${detail ? ` — ${detail}` : ""}.`;
    }
    case "connector.queue.added": return `Produit ${number(d.product_id)} ajouté à la file (${ORIGIN[text(d.origin)] ?? text(d.origin)}).`;
    case "connector.queue.dropped": return `Produit ${number(d.product_id)} retiré de la file : ${DROPPED[text(d.reason)] ?? text(d.reason)}.`;
    case "connector.reading.finished": return `Lecture du produit ${number(d.product_id)} : ${READING[text(d.outcome)] ?? text(d.outcome)}.`;
    case "connector.price.saved": return `Prix enregistré : produit ${number(d.product_id)}, magasin ${number(d.store_id)}, ${euros.format(number(d.price_cents) / 100)} (${CHANNEL[text(d.channel)] ?? text(d.channel)}).`;
    case "connector.failure": {
      const status = typeof d.http_status === "number" ? d.http_status : null;
      const cause = status !== null ? `le site a répondu HTTP ${status}${HTTP_MEANING[status] ? ` (${HTTP_MEANING[status]})` : status >= 500 ? " (erreur du site)" : ""}`
        : `${errorMeaning(text(d.error))} (${text(d.error)})`;
      return `Échec ${typeof d.product_id === "number" ? `de la lecture du produit ${d.product_id}` : "dans le connecteur"} : ${cause}.`;
    }
    case "connector.disabled": return "Connecteur désactivé automatiquement après des échecs. Il reste éteint jusqu’à sa réactivation dans les paramètres.";
    case "connector.worker.failed": return `Erreur dans le connecteur (${text(d.error)}).`;
    case "basket.prices.fetched": return `Prix du panier récupérés : ${plural(number(d.items), "article", "articles")}, ${plural(number(d.products), "produit", "produits")}${d.truncated ? " (limite de taille atteinte)" : ""} ; ${d.unlimited ? "compte sans limite de crédits" : `${plural(number(d.credits_left), "crédit restant", "crédits restants")} sur ce compte`}.`;
    case "basket.prices.refused": return "Récupération des prix du panier refusée : plus de crédit.";
    default: return `${item.event} ${Object.entries(d).map(([key, value]) => `${key}=${String(value)}`).join(" ")}`.trim();
  }
}
