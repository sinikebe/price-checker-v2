import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { Frame } from "./V2ProductWorkspace";
import { storeRequest } from "./v2-stores-api";
import "./v2-completion.css";

type ProductItem = { kind: "product"; id: number; name: string; brand: string; missing: string[] };
type StoreItem = { kind: "store"; id: number; name: string; retailer: string;
  city: string; postal_code: string; missing: string[] };
type Item = ProductItem | StoreItem;
type Result = { items: Item[]; total: number; required_total: number; optional_total: number;
  limit: number; offset: number };
type Priority = "required" | "optional";
const PAGE_SIZE = 50;

async function load(priority: Priority, page: number): Promise<Result> {
  const query = new URLSearchParams({ priority, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
  const response = await fetch("/api/v2/catalogue/to-complete?" + query, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("La liste des fiches à compléter est indisponible.");
  return response.json() as Promise<Result>;
}

function StoreCompletion({ item, onSaved }: { item: StoreItem; onSaved: () => void }) {
  const [city, setCity] = useState(item.city);
  const [postalCode, setPostalCode] = useState(item.postal_code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await storeRequest("/" + item.id + "/completion", "PUT", { city, postal_code: postalCode });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Correction impossible.");
    } finally { setBusy(false); }
  }
  return <form className="v2-completion-store-form" onSubmit={event => void submit(event)}>
    <label>Ville<input required maxLength={200} value={city} readOnly={Boolean(item.city)} disabled={busy}
      onChange={event => setCity(event.target.value)} /></label>
    <label>Code postal<input required maxLength={20} value={postalCode} readOnly={Boolean(item.postal_code)} disabled={busy}
      onChange={event => setPostalCode(event.target.value)} /></label>
    <button className="v2-button v2-button-secondary" disabled={busy}>{busy ? "Enregistrement…" : "Compléter ce magasin"}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}

function CompletionList({ priority, user, refresh, onSaved }: {
  priority: Priority; user: V2User | null; refresh: number; onSaved: () => void;
}) {
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    load(priority, page).then(value => {
      if (!active) return;
      if (page > 0 && page * PAGE_SIZE >= value.total) setPage(page - 1);
      else { setResult(value); setError(""); }
    })
      .catch(reason => { if (active) { setResult(null); setError(String(reason)); } });
    return () => { active = false; };
  }, [priority, page, refresh]);
  const title = priority === "required" ? "Priorité : champs obligatoires" : "Informations facultatives";
  return <section className="v2-workspace-card v2-completion-section">
    <h2>{title}{result && <span> · {result.total}</span>}</h2>
    <p>{priority === "required"
      ? "Ces fiches ont déjà été publiées, mais ne respectent pas les règles actuelles. Elles restent visibles dans le catalogue."
      : "Ces fiches sont publiables en l’état ; ces informations peuvent améliorer leur description."}</p>
    {error ? <p role="alert">{error}</p> : !result ? <p role="status">Chargement…</p>
      : !result.items.length ? <p>Aucune fiche dans cette section.</p>
      : <ul className="v2-completion-list">{result.items.map(item =>
        <li key={item.kind + "-" + item.id}>
          <div><strong>{item.kind === "product" ? [item.brand, item.name].filter(Boolean).join(" ") || "Produit sans nom"
            : item.retailer + " · " + item.name}</strong>
            <small>{item.kind === "product" ? "Produit" : "Magasin"} · À renseigner : {item.missing.join(", ")}</small>
            {item.kind === "store" && <small>{[item.city, item.postal_code].filter(Boolean).join(" · ") || "Localisation absente"}</small>}
          </div>
          {item.kind === "product" && <Link to={"/v2/produits/" + item.id}>Voir la fiche →</Link>}
          {item.kind === "store" && user?.role === "admin" && <StoreCompletion item={item} onSaved={onSaved} />}
        </li>)}</ul>}
    {result && result.total > PAGE_SIZE && <nav className="v2-completion-pages" aria-label={"Pagination " + title}>
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>← Précédent</button>
      <span>Page {page + 1} sur {Math.ceil(result.total / PAGE_SIZE)}</span>
      <button type="button" disabled={(page + 1) * PAGE_SIZE >= result.total} onClick={() => setPage(page + 1)}>Suivant →</button>
    </nav>}
  </section>;
}

export default function V2CompletionPage({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  const [refresh, setRefresh] = useState(0);
  return <Frame user={user} onLogout={onLogout}>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">CATALOGUE PUBLIC</span>
      <h1>À compléter<span>.</span></h1>
      <p>Retrouver les fiches publiées avant ou malgré des informations manquantes.</p>
    </div></div>
    <CompletionList priority="required" user={user} refresh={refresh} onSaved={() => setRefresh(value => value + 1)} />
    <CompletionList priority="optional" user={user} refresh={refresh} onSaved={() => setRefresh(value => value + 1)} />
  </Frame>;
}
