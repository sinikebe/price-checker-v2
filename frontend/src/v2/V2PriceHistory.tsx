import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
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
const money = (value: string | number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value));
const dayTime = (value: string) => new Date(value + "T12:00:00").getTime();
const date = (value: string | number) => new Date(typeof value === "string" && value.length === 10 ? value + "T12:00:00" : value)
  .toLocaleDateString("fr-FR", { year: "numeric", month: "short", day: "numeric" });
const seriesLabel = (row: Observation) => [row.retailer, row.store_name, row.city, row.postal_code, channels[row.sales_channel]].filter(Boolean).join(" · ");
function localToday() {
  const value = new Date();
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function initialForm(): DraftForm {
  return { retailer: "", store_name: "", city: "", postal_code: "", sales_channel: "in_store",
    price: "", observed_at: localToday(), note: "" };
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

const chartWidth = 800, chartHeight = 300, chartLeft = 62, chartRight = 22, chartTop = 22, chartBottom = 42;
const plotWidth = chartWidth - chartLeft - chartRight;
const plotHeight = chartHeight - chartTop - chartBottom;
const maxZoom = 128;
const pointLabel = (row: Observation) => [money(row.price), date(row.observed_at), seriesLabel(row)].join(" · ");

function PriceChart({ observations }: { observations: Observation[] }) {
  const points = observations.filter(row => row.available && row.correction_status !== "active")
    .sort((a, b) => dayTime(a.observed_at) - dayTime(b.observed_at) || a.id - b.id);
  if (!points.length) return <p>Aucun relevé disponible à tracer.</p>;
  return <InteractivePriceChart points={points} />;
}

function InteractivePriceChart({ points }: { points: Observation[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const clipId = "v2-price-clip-" + useId().replace(/:/g, "");
  const tooltipId = "v2-price-tooltip-" + useId().replace(/:/g, "");
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const [hovered, setHovered] = useState<{ row: Observation; left: number; top: number; above: boolean } | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, maxZoom])
      .extent([[chartLeft, chartTop], [chartWidth - chartRight, chartHeight - chartBottom]])
      .translateExtent([[chartLeft, chartTop], [chartWidth - chartRight, chartHeight - chartBottom]])
      .touchable(() => false)
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        setTransform(event.transform);
        setHovered(null);
      });
    const selection = select(svg);
    selection.call(behavior);
    zoomRef.current = behavior;
    return () => {
      selection.on(".zoom", null);
      zoomRef.current = null;
    };
  }, []);

  const times = points.map(row => dayTime(row.observed_at));
  const first = Math.min(...times), last = Math.max(...times);
  const fullStart = first === last ? first - 12 * 60 * 60 * 1000 : first;
  const fullEnd = first === last ? last + 12 * 60 * 60 * 1000 : last;
  const fullSpan = fullEnd - fullStart;
  const values = points.map(row => Number(row.price));
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max(0.1, (high - low) * .15);
  const min = Math.max(0, low - padding), max = high + padding;
  const baseX = (row: Observation) => chartLeft + (dayTime(row.observed_at) - fullStart) / fullSpan * plotWidth;
  const x = (row: Observation) => transform.applyX(baseX(row));
  const y = (row: Observation) => chartTop + (max - Number(row.price)) / (max - min) * plotHeight;
  const axisTime = (pixel: number) => fullStart + (transform.invertX(pixel) - chartLeft) / plotWidth * fullSpan;
  const visibleStart = axisTime(chartLeft), visibleEnd = axisTime(chartWidth - chartRight);
  const axisDate = (value: number) => date(value);

  function changeZoom(factor: number) {
    if (svgRef.current && zoomRef.current)
      zoomRef.current.scaleBy(select(svgRef.current), factor, [chartLeft + plotWidth / 2, chartTop + plotHeight / 2]);
  }
  function moveView(direction: number) {
    if (svgRef.current && zoomRef.current)
      zoomRef.current.translateBy(select(svgRef.current), direction * plotWidth * .25 / transform.k, 0);
  }
  function resetView() {
    if (svgRef.current && zoomRef.current)
      zoomRef.current.transform(select(svgRef.current), zoomIdentity);
  }
  function showTooltip(row: Observation, clientX: number, clientY: number) {
    setHovered({
      row,
      left: Math.max(12, Math.min(clientX + 14, window.innerWidth - 250)),
      top: clientY > 140 ? clientY - 12 : clientY + 18,
      above: clientY > 140,
    });
  }

  return <>
    <div className="v2-price-chart-controls">
      <div className="v2-price-chart-buttons" aria-label="Commandes du graphique des prix">
        <button type="button" onClick={() => changeZoom(1.6)} disabled={transform.k >= maxZoom - .01} aria-label="Zoomer">+</button>
        <button type="button" onClick={() => changeZoom(1 / 1.6)} disabled={transform.k <= 1.001} aria-label="Dézoomer">−</button>
        <button type="button" onClick={() => moveView(.25)} disabled={transform.k <= 1.001} aria-label="Reculer dans le temps">←</button>
        <button type="button" onClick={() => moveView(-.25)} disabled={transform.k <= 1.001} aria-label="Avancer dans le temps">→</button>
        <button type="button" onClick={resetView} disabled={transform.k <= 1.001}>Réinitialiser</button>
      </div>
      <span className="v2-price-chart-range" role="status">{axisDate(visibleStart)} – {axisDate(visibleEnd)}{transform.k > 1.001 && " · ×" + transform.k.toFixed(1)}</span>
    </div>
    <p className="v2-price-chart-help">À la souris : molette pour zoomer dans le temps, glisser pour se déplacer. Sur mobile et au clavier, utilisez les boutons.</p>
    <div className="v2-price-chart-scroll">
      <svg ref={svgRef} className="v2-price-chart" viewBox={["0", "0", chartWidth, chartHeight].join(" ")}
        role="group" aria-labelledby="v2-price-chart-title v2-price-chart-description">
        <title id="v2-price-chart-title">Évolution des prix relevés</title>
        <desc id="v2-price-chart-description">Une seule courbe relie les prix disponibles et non contestés. Zoomez sur les dates avec la molette ou les boutons, déplacez la vue en glissant et réinitialisez-la avec le bouton. Chaque point est accessible au clavier ; le tableau contient tous les relevés.</desc>
        <defs>
          <clipPath id={clipId}><rect x={chartLeft} y={chartTop} width={plotWidth} height={plotHeight} /></clipPath>
          <clipPath id={clipId + "-dots"}><rect x={chartLeft - 9} y={chartTop - 9} width={plotWidth + 18} height={plotHeight + 18} /></clipPath>
        </defs>
        {[0, .5, 1].map(fraction => {
          const value = min + (max - min) * fraction;
          const ordinate = chartTop + (1 - fraction) * plotHeight;
          return <g key={fraction}><line x1={chartLeft} y1={ordinate} x2={chartWidth - chartRight} y2={ordinate} className="v2-price-gridline" />
            <text x={chartLeft - 10} y={ordinate + 4} textAnchor="end" className="v2-price-axis-label">{money(value)}</text></g>;
        })}
        <text x={chartLeft} y={chartHeight - 12} className="v2-price-axis-label">{axisDate(visibleStart)}</text>
        <text x={chartWidth - chartRight} y={chartHeight - 12} textAnchor="end" className="v2-price-axis-label">{axisDate(visibleEnd)}</text>
        {points.length > 1 && <g clipPath={"url(#" + clipId + ")"}>
          <polyline className="v2-price-line" fill="none" strokeWidth="3"
            points={points.map(row => [x(row), y(row)].join(",")).join(" ")} />
        </g>}
        <g clipPath={"url(#" + clipId + "-dots)"}>
          {points.map(row => <circle className="v2-price-dot" key={row.id} cx={x(row)} cy={y(row)} r="7"
            stroke="var(--v2-price-dot-border, #fff)" strokeWidth="2" tabIndex={0}
            aria-label={pointLabel(row)} aria-describedby={hovered?.row.id === row.id ? tooltipId : undefined}
            onPointerEnter={event => showTooltip(row, event.clientX, event.clientY)}
            onPointerMove={event => showTooltip(row, event.clientX, event.clientY)}
            onPointerLeave={() => setHovered(null)}
            onFocus={event => { const bounds = event.currentTarget.getBoundingClientRect(); showTooltip(row, bounds.right, bounds.top); }}
            onBlur={() => setHovered(null)} />)}
        </g>
      </svg>
    </div>
    {hovered && <div id={tooltipId} className="v2-price-tooltip" role="tooltip"
      style={{ left: hovered.left, top: hovered.top, transform: hovered.above ? "translateY(-100%)" : undefined }}>
      <strong>{money(hovered.row.price)}</strong>
      <span>{date(hovered.row.observed_at)}</span>
      <span>{seriesLabel(hovered.row)}</span>
    </div>}
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
        ...form,
      });
      setForm(previous => ({ ...previous, price: "", note: "", observed_at: localToday() }));
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
      <p>Tous les prix disponibles et non contestés de cette référence sont reliés sur une seule courbe.</p></div>
      {latest && <strong className="v2-price-latest">Dernier relevé : {money(latest.price)}</strong>}
    </div>
    {!prices && !error && <p>Chargement des prix…</p>}
    {prices && (observations.length ? <>
      <PriceChart observations={observations} />
      <div className="v2-price-table-scroll"><table>
        <caption>Relevés publiés de ce produit</caption>
        <thead><tr><th>Date</th><th>Prix</th><th>Enseigne et point de vente</th><th>Canal</th><th>Source</th></tr></thead>
        <tbody>{observations.map(row => <tr key={row.id}>
          <td>{date(row.observed_at)}</td><td><strong>{money(row.price)}</strong>{!row.available && <small> Indisponible</small>}{row.correction_status === "active" && <small> Contesté</small>}</td>
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
          <label>Date du relevé<input type="date" required value={form.observed_at} disabled={busy}
            onChange={event => setForm({ ...form, observed_at: event.target.value })} /></label>
          <label>Précision facultative<input maxLength={1000} value={form.note} disabled={busy}
            onChange={event => setForm({ ...form, note: event.target.value })} />
            <small>Ce texte sera vérifié avant publication. N'indiquez ni nom, ni coordonnées, ni donnée personnelle.</small></label>
        </div>
        <button type="submit" className="v2-button v2-button-primary" disabled={busy}>{busy ? "Envoi…" : "Envoyer le relevé"}</button>
      </form>
    </div>}
    {user && drafts && drafts.length > 0 && <div className="v2-price-drafts"><h3>{user.role === "admin" ? "Propositions à examiner" : "Mes propositions"}</h3>
        <ul>{drafts.map(draft => <li key={draft.id}>
          <span><strong>{money(draft.price)}</strong> · {draft.retailer} · {draft.store_name} · {channels[draft.sales_channel]} · {date(draft.observed_at)}
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
