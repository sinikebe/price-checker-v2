import type { QueueBadge } from "./v2-connector-page-refresh";
import "./v2-connector-queue.css";

export function V2ConnectorQueueIndicator({ badge }: { badge: QueueBadge }) {
  const label = badge.status === "running" ? "Relevé en cours"
    : `En attente${badge.rank ? ` · n° ${badge.rank}` : ""}`;
  return <span className="v2-connector-queue-badge" role="status"
    title={[badge.connector, badge.store_name, label].filter(Boolean).join(" · ")}>{label}</span>;
}
