import { Link } from "react-router-dom";
import V2HostHealth from "./V2HostHealth";
import V2SearchSettings from "./V2SearchSettings";
import V2ServerUpdateSchedule from "./V2ServerUpdateSchedule";
import V2TransferPanel from "./V2TransferPanel";

/** Administrator-only: the instance itself (host health, server updates, catalogue search, data transfer, hostname and database). */
export default function V2SettingsServer({ userId }: { userId: number }) {
  return <>
    <V2HostHealth />
    <V2ServerUpdateSchedule key={userId} />
    <V2SearchSettings key={`search-${userId}`} />
    <V2TransferPanel key={`transfer-${userId}`} />
    <section className="v2-settings-card" aria-labelledby="v2-server-heading">
      <h2 id="v2-server-heading">Serveur</h2>
      <p>Nom d’hôte et configuration PostgreSQL de cette instance.</p>
      <Link className="v2-settings-link" to="/v2/settings/database">Paramètres du serveur →</Link>
    </section>
  </>;
}
