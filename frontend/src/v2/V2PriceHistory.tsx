import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { V2User } from "./v2-auth-api";
import "./v2-price-history.css";

type Observation = {
  id: number; price: string; observed_at: string; retailer: string; retailer_id: number;
  store_name: string; store_id: number; city: string | null; postal_code: string | null; sales_channel: Channel;
  source: "manual" | "connector" | "third_party"; source_provider: string | null;
  available: boolean; correction_status: string | null; note: string | null;
};
type PriceDraft = Pick<Observation, "id" | "price" | "observed_at" | "retailer" | "store_name" | "city" | "sales_channel" | "note"> & {
  author: string; author_id: number; status: "draft" | "approved" | "rejected";
};
type Channel = "in_store" | "drive" | "delivery";
type DraftForm = { retailer: string; store_name: string; city: string; postal_code: string;
  sales_channel: Channel; price: string; observed_at: string; note: string };
type PricesResponse = { observations: Observation[]; truncated: boolean };
const channels: Record<Channel, string> = { in_store: "En magasin", drive: "Drive", delivery: "Livraison" };
const colors = ["#227856", "#2b67ad", "#a46b18", "#a43c74", "#6954a9", "#a44632"];
const money = (value: string | number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value));
const date = (value: string) => new Date(value).toLocaleDateString("fr-FR", { year: "numeric", month: "short", day: "numeric" });
const dateTime = (value: string) => new Date(value).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const seriesLabel = (row: Observation) => [row.retailer, row.store_name, row.city, row.postal_code, channels[row.sales_channel]].filter(Boolean).join(" · ");
const seriesKey = (row: Observation) => row.store_id + ":" + row.sales_channel;
function localNow() {
  const value = new Date();
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function initialForm(): DraftForm {
  return { retailer: "", store_name: "", city: "", postal_code: "", sales_channel: "in_store",
    price: "", observed_at: localNow(), note: "" };
}

async function priceRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch("/api/v2/prices" + path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data
      ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : "Impossible de charger les prix.");
  }
  return response.json() as Promise<T>;
}

function PriceChart({ observations }: { observations: Observation[] }) {
  const points = observations.filter(row => row.available && row.correction_status !== "active")
    .slice().reverse();
  if (!points.length) return <p>Aucun relevé disponible à tracer.</p>;
  const series = [...new Map(points.map(row => [seriesKey(row), seriesLabel(row)])).entries()];
  const width = 800, height = 300, left = 62, right = 22, top = 22, bottom = 42;
  const values = points.map(row => Number(row.price));
  const min = Math.max(0, Math.min(...values) - Math.max(0.1, (Math.max(...values) - Math.min(...values)) * .15));
  const max = Math.max(...values) + Math.max(0.1, (Math.max(...values) - Math.min(...values)) * .15);
  const times = points.map(row => new Date(row.observed_at).getTime());
  const start = Math.min(...times), end = Math.max(...times);
  const x = (row: Observation) => left + ((new Date(row.observed_at).getTime() - start) / (end - start || 1)) * (width - left - right);
  const y = (row: Observation) => top + ((max - Number(row.price)) / (max - min)) * (height - top - bottom);
  const singleX = (row: Observation) => start === end ? (left + width - right) / 2 : x(row);
  return <>
    <div className="v2-price-chart-scroll">
      <svg className="v2-price-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="v2-price-chart-title v2-price-chart-description">
        <title id="v2-price-chart-title">Évolution des prix relevés</title>
        <desc id="v2-price-chart-description">Un tracé par point de vente et canal. Le tableau suivant contient chaque relevé avec sa date et son prix.</desc>
        {[0, .5, 1].map(fraction => {
          const value = min + (max - min) * fraction;
          const ordinate = top + (1 - fraction) * (height - top - bottom);
          return <g key={fraction}><line x1={left} y1={ordinate} x2={width - right} y2={ordinate} className="v2-price-gridline" />
            <text x={left - 10} y={ordinate + 4} textAnchor="end" className="v2-price-axis-label">{money(value)}</text></g>;
        })}
        <text x={left} y={height - 12} className="v2-price-axis-label">{date(new Date(start).toISOString())}</text>
        <text x={width - right} y={height - 12} textAnchor="end" className="v2-price-axis-label">{date(new Date(end).toISOString())}</text>
        {series.map(([key, label], index) => {
          const group = points.filter(row => seriesKey(row) === key);
          const color = colors[index % colors.length];
          return <g key={key}>
            {group.length > 1 && <polyline fill="none" stroke={color} strokeWidth="3"
              points={group.map(row => `${singleX(row)},${y(row)}`).join(" ")} />}
            {group.map(row => <circle key={row.id} cx={singleX(row)} cy={y(row)} r="6"
              fill={color} stroke="var(--v2-price-dot-border, #fff)" strokeWidth="2">
              <title>{label} · {date(row.observed_at)} · {money(row.price)}</title>
            </circle>)}
          </g>;
        })}
      </svg>
    </div>
    <div className="v2-price-legend" aria-label="Séries du graphique">{series.map(([key, label], index) =>
      <span key={key}><i style={{ backgroundColor: colors[index % colors.length] }} aria-hidden="true" />{label}</span>)}</div>
  </>;
}

export default function V2PriceHistory({ productId, user, current }: { productId: number; user: V2User | null; current: boolean }) {
  const userId = user?.id;
  const [prices, setPrices] = useState<PricesResponse | null>(null);
  const [drafts, setDrafts] = useState<PriceDraft[] | null>(null);
  const [form, setForm] = useState<DraftForm>(initialForm);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const nextPrices = await priceRequest<PricesResponse>(`/products/${productId}`);
      setPrices(nextPrices);
      if (userId != null) {
        const nextDrafts = await priceRequest<PriceDraft[]>(`/products/${productId}/drafts`);
        setDrafts(nextDrafts);
      }
      setError("");
    } catch (reason) {
      // Keep both the chart and any unsent form fields mounted on a refresh failure.
      setError(reason instanceof Error ? reason.message : "Chargement des prix impossible.");
    }
  }, [productId, userId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await priceRequest(`/products/${productId}/drafts`, "POST", {
        ...form, observed_at: new Date(form.observed_at).toISOString(),
      });
      setForm(previous => ({ ...previous, price: "", note: "", observed_at: localNow() }));
      setNotice("Relevé envoyé. Il sera visible publiquement après validation.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Enregistrement impossible.");
    } finally { setBusy(false); }
  }

  async function review(id: number, action: "approve" | "reject") {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await priceRequest(`/drafts/${id}/${action}`, "POST");
      setNotice(action === "approve" ? "Relevé publié." : "Relevé refusé.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Validation impossible.");
    } finally { setBusy(false); }
  }

  const observations = prices?.observations ?? [];
  const latest = observations.find(row => row.available && row.correction_status !== "active");
  return <section className="v2-workspace-card v2-price-history" aria-labelledby="v2-price-heading">
    <div className="v2-price-heading"><div><h2 id="v2-price-heading">Prix relevés</h2>
      <p>Historique de cette référence précise, par point de vente et canal.</p></div>
      {latest && <strong className="v2-price-latest">Dernier relevé : {money(latest.price)}</strong>}
    </div>
    {!prices && !error && <p>Chargement des prix…</p>}
    {prices && (observations.length ? <>
      <PriceChart observations={observations} />
      <div className="v2-price-table-scroll"><table>
        <caption>Relevés publiés de ce produit</caption>
        <thead><tr><th>Date</th><th>Prix</th><th>Enseigne et point de vente</th><th>Canal</th><th>Source</th></tr></thead>
        <tbody>{observations.map(row => <tr key={row.id}>
          <td>{dateTime(row.observed_at)}</td><td><strong>{money(row.price)}</strong>{!row.available && <small> Indisponible</small>}{row.correction_status === "active" && <small> Contesté</small>}</td>
          <td>{row.retailer} · {row.store_name}{row.city && ` · ${row.city}`}</td>
          <td>{channels[row.sales_channel]}</td>
          <td>{row.source === "manual" ? "Relevé validé" : row.source === "third_party" ? row.source_provider || "Source externe" : "Connecteur"}</td>
        </tr>)}</tbody>
      </table></div>
      {prices.truncated && <p className="v2-price-note">Seuls les 200 relevés les plus récents sont affichés.</p>}
    </> : <p>Aucun prix publié pour cette référence. Un relevé validé apparaîtra ici.</p>)}
    {user && current && <div className="v2-price-contribute">
      <h3>Proposer un relevé</h3>
      <p>Votre prix restera privé jusqu’à validation. Indiquez le prix du conditionnement affiché sur cette fiche.</p>
      <form onSubmit={event => void submit(event)}>
        <div className="v2-price-fields">
          <label>Enseigne<input required maxLength={200} value={form.retailer} disabled={busy}
            onChange={event => setForm({ ...form, retailer: event.target.value })} /></label>
          <label>Point de vente ou service<input required maxLength={300} value={form.store_name} disabled={busy}
            onChange={event => setForm({ ...form, store_name: event.target.value })} /></label>
          <label>Ville ou zone desservie<input required maxLength={200} value={form.city} disabled={busy}
            onChange={event => setForm({ ...form, city: event.target.value })} /></label>
          <label>Code postal<input maxLength={20} value={form.postal_code} disabled={busy}
            onChange={event => setForm({ ...form, postal_code: event.target.value })} /></label>
          <label>Canal<select value={form.sales_channel} disabled={busy}
            onChange={event => setForm({ ...form, sales_channel: event.target.value as Channel })}>
            {Object.entries(channels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>Prix en euros<input type="number" min="0" max="99999999.99" step="0.01" inputMode="decimal"
            required value={form.price} disabled={busy}
            onChange={event => setForm({ ...form, price: event.target.value })} /></label>
          <label>Date et heure du relevé<input type="datetime-local" required value={form.observed_at} disabled={busy}
            onChange={event => setForm({ ...form, observed_at: event.target.value })} /></label>
          <label>Précision facultative<input maxLength={1000} value={form.note} disabled={busy}
            onChange={event => setForm({ ...form, note: event.target.value })} /></label>
        </div>
        <button type="submit" className="v2-button v2-button-primary" disabled={busy}>{busy ? "Envoi…" : "Envoyer le relevé"}</button>
      </form>
    </div>}
    {user && drafts && drafts.length > 0 && <div className="v2-price-drafts"><h3>{user.role === "admin" ? "Propositions à examiner" : "Mes propositions"}</h3>
        <ul>{drafts.map(draft => <li key={draft.id}>
          <span><strong>{money(draft.price)}</strong> · {draft.retailer} · {draft.store_name} · {channels[draft.sales_channel]} · {dateTime(draft.observed_at)}
            {draft.note && <small> · {draft.note}</small>}
            <small> · {draft.status === "draft" ? "En attente" : draft.status === "approved" ? "Publié" : "Refusé"}{user.role === "admin" && draft.author_id !== user.id && ` · ${draft.author}`}</small></span>
          {user.role === "admin" && draft.status === "draft" && <span className="v2-price-review">
            <button type="button" disabled={busy} onClick={() => void review(draft.id, "approve")}>Publier</button>
            <button type="button" disabled={busy} onClick={() => void review(draft.id, "reject")}>Refuser</button>
          </span>}
        </li>)}</ul>
    </div>}
    {!current && <p className="v2-price-note">Cette référence a été remplacée : les nouveaux relevés concernent sa version actuelle.</p>}
    {!user && current && <p className="v2-price-note">Connectez-vous pour proposer un relevé.</p>}
    {error && <p role="alert" className="v2-price-error">{error}</p>}
    {notice && <p role="status" className="v2-price-success">{notice}</p>}
  </section>;
}
