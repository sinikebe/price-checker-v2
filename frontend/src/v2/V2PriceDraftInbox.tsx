import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import "./v2-price-draft-inbox.css";

type Item = {
  id: number; product_id: number | null; product_draft_id: number | null;
  product_name: string; product_brand: string; author: string;
  price: string; observed_at: string; retailer: string; store_name: string;
  sales_channel: "in_store" | "drive" | "delivery";
  status: "draft" | "rejected"; store_active: boolean;
};
type Result = { items: Item[]; total: number; limit: number; offset: number };
type Mode = "mine" | "review";
const PAGE_SIZE = 30;
const channels = { in_store: "Magasin", drive: "Drive", delivery: "Livraison" };
const money = (value: string) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value));

async function request<T>(path: string, method = "GET"): Promise<T> {
  const response = await fetch("/api/v2/prices" + path, { method, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : "Impossible de charger les propositions de prix.");
  }
  return response.json() as Promise<T>;
}

export default function V2PriceDraftInbox({ mode, user }: { mode: Mode; user: V2User | null }) {
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!user || (mode === "review" && user.role !== "admin")) return;
    let active = true;
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    request<Result>(`/drafts/${mode}?${query}`).then(value => {
      if (!active) return;
      if (page > 0 && page * PAGE_SIZE >= value.total) setPage(page - 1);
      else { setResult(value); setError(""); }
    }).catch(reason => { if (active) { setResult(null); setError(String(reason)); } });
    return () => { active = false; };
  }, [mode, user, page, reload]);

  async function review(id: number, action: "approve" | "reject") {
    if (busy !== null) return;
    setBusy(id); setError("");
    try { await request(`/drafts/${id}/${action}`, "POST"); setReload(value => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Validation impossible."); }
    finally { setBusy(null); }
  }

  if (!user || (mode === "review" && user.role !== "admin")) return null;
  return <section className="v2-workspace-card v2-price-draft-inbox" aria-label="Propositions de prix">
    <h2>Propositions de prix{result && <span> · {result.total}</span>}</h2>
    {error && <p role="alert">{error}</p>}
    {!result && !error ? <p>Chargement…</p> : result?.items.length === 0 ? <p>Aucune proposition de prix {mode === "review" ? "à valider" : "en attente ou refusée"}.</p> :
      <ul className="v2-price-draft-inbox-list">{result?.items.map(item => {
        const target = item.product_id ? `/v2/produits/${item.product_id}` : `/v2/brouillons/${item.product_draft_id}`;
        return <li key={item.id}>
          <div><strong>{[item.product_brand, item.product_name].filter(Boolean).join(" ") || "Produit sans nom"}</strong>
            <small>{money(item.price)} · {item.retailer} · {item.store_name} · {channels[item.sales_channel]} · {new Date(item.observed_at + "T12:00:00").toLocaleDateString("fr-FR")}</small>
            {mode === "review" && <small>Proposé par {item.author}</small>}
            {item.status === "rejected" && <small>Refusé</small>}
            {!item.product_id && <small>Fiche produit à valider avant ce prix.</small>}
            {!item.store_active && <small>Magasin désactivé : ce prix ne peut pas être publié.</small>}
          </div>
          <div className="v2-price-draft-inbox-actions">
            <Link to={target}>{item.product_id ? "Voir le produit" : "Voir le brouillon produit"} →</Link>
            {mode === "review" && <>
              <button type="button" disabled={busy !== null || !item.product_id || !item.store_active}
                onClick={() => { void review(item.id, "approve"); }}>Publier</button>
              <button type="button" disabled={busy !== null}
                onClick={() => { void review(item.id, "reject"); }}>Refuser</button>
            </>}
          </div>
        </li>;
      })}</ul>}
    {result && result.total > PAGE_SIZE && <nav className="v2-price-draft-inbox-pages" aria-label="Pages des propositions de prix">
      <button type="button" disabled={page === 0 || busy !== null} onClick={() => setPage(page - 1)}>← Précédent</button>
      <span>Page {page + 1} sur {Math.ceil(result.total / PAGE_SIZE)}</span>
      <button type="button" disabled={(page + 1) * PAGE_SIZE >= result.total || busy !== null} onClick={() => setPage(page + 1)}>Suivant →</button>
    </nav>}
  </section>;
}
