import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import { Frame } from "./V2ProductWorkspace";
import { emptyProduct, ProductApiError, productRequest, type Draft, type Product, type ProductData } from "./v2-products-api";
import bookmarkletSource from "./bookmarklet-capture.js?raw";
import versions from "./component-versions.json";
import "./v2-capture.css";

type Payload = { v: 2; url: string; host: string; name: string | null; brand: string | null;
  ean: string | null; quantity: string | null; price: number | null; source: string | null; capturedAt: string };
type Match = { kind: "product" | "draft"; id: number };
type Resolution = { status: "loading" | "product" | "draft" | "missing" | "no-ean" | "error";
  id?: number; product?: Product; draft?: Draft; message?: string };
type Store = { retailer: string; store_name: string; city: string; postal_code: string; sales_channel: "in_store" | "drive" | "delivery" };
type ProductFields = Pick<ProductData, "name" | "brand" | "package" | "quantity">;
type Submitted = { productId?: number; productDraftId?: number; createdProductDraft?: boolean };
function capturedProductFields(payload: Payload | null): ProductFields {
  return { name: (payload?.name || "").slice(0, 160), brand: (payload?.brand || "").slice(0, 100),
    package: "", quantity: (payload?.quantity || "").slice(0, 80) };
}
const pendingKey = "v2:capture:pending";
const bookmarkletLabel = "Capturer ce prix v" + versions.bookmarklet.version;
const channels: Record<Store["sales_channel"], string> = { in_store: "En magasin", drive: "Drive", delivery: "Livraison" };
const hosts: { domain: string; name: string }[] = [
  { domain: "intermarche.com", name: "Intermarché" }, { domain: "auchan.fr", name: "Auchan" },
  { domain: "carrefour.fr", name: "Carrefour" }, { domain: "leclercdrive.fr", name: "E.Leclerc" },
  { domain: "coursesu.com", name: "Courses U" }, { domain: "picard.fr", name: "Picard" },
];
const fallbackStore: Store = { retailer: "", store_name: "", city: "", postal_code: "", sales_channel: "drive" };

function retailerFor(host: string) {
  return hosts.find(item => host === item.domain || host.endsWith("." + item.domain))?.name || "";
}
function parsePayload(raw: string | null): Payload | null {
  if (!raw || raw.length > 5000) return null;
  try {
    const item: unknown = JSON.parse(raw);
    if (!item || typeof item !== "object") return null;
    const data = item as Record<string, unknown>;
    if (data.v !== 2 || typeof data.url !== "string" || typeof data.host !== "string") return null;
    const url = new URL(data.url);
    if (url.protocol !== "https:" || url.hostname !== data.host || url.username || url.password
      || url.search || url.hash || data.url.length > 600) return null;
    const optional = (name: string, max: number) => typeof data[name] === "string" && (data[name] as string).length <= max
      ? data[name] as string : null;
    const price = typeof data.price === "number" && Number.isFinite(data.price) && data.price > 0
      && data.price <= 99999999.99 ? data.price : null;
    const ean = optional("ean", 14);
    return { v: 2, url: data.url, host: data.host, name: optional("name", 180), brand: optional("brand", 100),
      ean: ean && /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(ean) ? ean : null,
      quantity: optional("quantity", 100), price, source: optional("source", 40),
      capturedAt: optional("capturedAt", 40) || "" };
  } catch { return null; }
}
function payloadFromLocation(hash: string): Payload | null {
  if (hash.startsWith("#p=")) {
    try { return parsePayload(decodeURIComponent(hash.slice(3))); } catch { return null; }
  }
  try { return parsePayload(sessionStorage.getItem(pendingKey)); } catch { return null; }
}
function storedStore(retailer: string): Store {
  if (!retailer) return fallbackStore;
  try {
    const raw = localStorage.getItem("v2:capture:store:" + retailer);
    if (raw) {
      const data = JSON.parse(raw) as Partial<Store>;
      if (data.retailer === retailer && typeof data.store_name === "string" && typeof data.city === "string"
        && typeof data.postal_code === "string" && data.sales_channel && data.sales_channel in channels)
        return { retailer, store_name: data.store_name, city: data.city, postal_code: data.postal_code,
          sales_channel: data.sales_channel };
    }
  } catch { /* Storage is optional. */ }
  return { ...fallbackStore, retailer };
}
function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function Install({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  const anchor = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);
  // Percent-encoding preserves source newlines and comments when Chrome saves the javascript: URL.
  const href = useMemo(() => "javascript:" + encodeURIComponent(bookmarkletSource.replace('"__V2_CAPTURE_URL__"',
    JSON.stringify(window.location.origin + "/v2/capture"))), []);
  useEffect(() => { anchor.current?.setAttribute("href", href); }, [href]);
  async function copy() {
    try { await navigator.clipboard.writeText(href); setCopied(true); }
    catch { setCopied(false); }
  }
  return <Frame user={user} onLogout={onLogout}>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">CAPTURE DE PRIX <span className="v2-beta-tag">Bêta</span></span>
      <h1>Installer le bookmarklet<span>.</span></h1>
      <p>Relevez le prix d’une fiche que vous avez déjà ouverte dans le navigateur.</p></div></div>
    <section className="v2-workspace-card v2-capture">
      <h2>{bookmarkletLabel}</h2>
      <p>Glissez ce lien dans la barre des favoris, ou copiez-le et créez un favori dont l’adresse est le texte copié.</p>
      <p><a ref={anchor} href="#" className="v2-button v2-button-primary" onClick={event => event.preventDefault()}>{bookmarkletLabel}</a>
        <button type="button" className="v2-button v2-button-secondary" onClick={() => void copy()}>{copied ? "Copié" : "Copier le lien"}</button></p>
      <ol><li>Choisissez le magasin ou Drive sur le site de l’enseigne, puis ouvrez une fiche produit dont le prix est visible.</li>
        <li>Utilisez le favori « {bookmarkletLabel} ». Il lit uniquement la page ouverte et ne contacte pas l’enseigne.</li>
        <li>Dans V2, vérifiez la référence, le conditionnement, le prix et le point de vente avant de proposer la fiche et son prix en une seule action si l’EAN est nouveau.</li></ol>
      <p>Le point de vente saisi est mémorisé dans ce navigateur pour les prochaines captures de la même enseigne. Aucun prix n’est publié sans validation.</p>
      <p><Link to="/v2/produits">Retour aux produits</Link></p>
    </section>
  </Frame>;
}

function Review({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  const location = useLocation();
  const payload = useMemo(() => payloadFromLocation(location.hash), [location.hash]);
  const [resolution, setResolution] = useState<Resolution>({ status: "loading" });
  const [store, setStore] = useState<Store>(() => storedStore(retailerFor(payload?.host || "")));
  const [productFields, setProductFields] = useState<ProductFields>(() => capturedProductFields(payload));
  const [price, setPrice] = useState(payload?.price?.toFixed(2) || "");
  const [observedAt, setObservedAt] = useState(today());
  const [note, setNote] = useState(payload && retailerFor(payload.host) ? "Page produit : " + payload.url : "");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<Submitted | null>(null);
  useEffect(() => {
    if (!payload) { setResolution({ status: "no-ean" }); return; }
    try { sessionStorage.setItem(pendingKey, JSON.stringify(payload)); } catch { /* Fragment still works. */ }
    setStore(storedStore(retailerFor(payload.host)));
    setProductFields(capturedProductFields(payload));
    setPrice(payload.price?.toFixed(2) || "");
    setNote(retailerFor(payload.host) ? "Page produit : " + payload.url : "");
    setConfirmed(false); setSent(null); setError("");
    if (!payload.ean) { setResolution({ status: "no-ean" }); return; }
    let active = true;
    setResolution({ status: "loading" });
    productRequest<Match>("/by-barcode/" + payload.ean).then(async match => {
      if (match.kind === "draft") {
        const draft = await productRequest<Draft>("/drafts/" + match.id);
        return { status: "draft", id: match.id, draft } as Resolution;
      }
      const product = await productRequest<Product>("/" + match.id);
      return { status: "product", id: match.id, product } as Resolution;
    }).then(next => { if (active) setResolution(next); }).catch(reason => {
      if (active) setResolution(reason instanceof ProductApiError && reason.status === 404
        ? { status: "missing" } : { status: "error", message: reason instanceof Error ? reason.message : "Recherche indisponible." });
    });
    return () => { active = false; };
  }, [payload, user?.id]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || !payload?.ean || !confirmed || busyRef.current ||
      (resolution.status !== "product" && resolution.status !== "draft" && resolution.status !== "missing")) return;
    busyRef.current = true;
    setBusy(true); setError("");
    try {
      const pricePayload = { ...store, price, observed_at: observedAt, note };
      let next: Submitted;
      if (resolution.status === "product" && resolution.id) {
        const response = await fetch("/api/v2/prices/products/" + resolution.id + "/drafts", {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pricePayload),
        });
        if (!response.ok) throw await submissionError(response);
        next = { productId: resolution.id };
      } else {
        const retailer = retailerFor(payload.host);
        const productData: ProductData = { ...emptyProduct(), ...productFields, ean: payload.ean,
          retailer_links: retailer ? [{ retailer, url: payload.url, source: "capture" }] : [] };
        const response = await fetch("/api/v2/prices/capture-drafts", {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ean: payload.ean, source_url: payload.url, price: pricePayload,
            ...(resolution.status === "draft" && resolution.id
              ? { product_draft_id: resolution.id } : { product_data: productData }) }),
        });
        if (!response.ok) throw await submissionError(response);
        const result = await response.json() as { product_draft_id: number; created_product_draft: boolean };
        next = { productDraftId: result.product_draft_id, createdProductDraft: result.created_product_draft };
      }
      try { localStorage.setItem("v2:capture:store:" + store.retailer, JSON.stringify(store)); } catch { /* Optional preference. */ }
      try { sessionStorage.removeItem(pendingKey); } catch { /* No-op. */ }
      window.history.replaceState(null, "", "/v2/capture");
      setSent(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Enregistrement impossible."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const canContribute = resolution.status === "product" || resolution.status === "draft" || resolution.status === "missing";
  return <Frame user={user} onLogout={onLogout}>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">CAPTURE DE PRIX <span className="v2-beta-tag">Bêta</span></span>
      <h1>Vérifier le relevé<span>.</span></h1><p>La page consultée fournit une proposition, jamais un prix publié automatiquement.</p></div></div>
    <section className="v2-workspace-card v2-capture">
      {sent ? <div role="status"><h2>{sent.productDraftId ? sent.createdProductDraft ? "Fiche et prix proposés" : "Prix joint au brouillon" : "Relevé proposé"}</h2>
        <p>{sent.productDraftId ? "La fiche reste privée jusqu’à validation. Son prix sera examiné séparément après publication de la fiche." : "Le prix restera privé jusqu’à validation."}</p>
        <p>{sent.productDraftId ? <Link to={"/v2/brouillons/" + sent.productDraftId}>Voir et compléter le brouillon</Link>
          : <Link to={"/v2/produits/" + sent.productId}>Voir le produit</Link>} · <Link to="/v2/capture/installer">Capturer une autre fiche</Link></p></div>
      : !payload ? <div role="alert"><p>Aucune capture lisible. Installez le bookmarklet puis utilisez-le sur une fiche produit.</p>
        <Link to="/v2/capture/installer">Installer le bookmarklet</Link></div>
      : <>
        <h2>{payload.name || "Produit sans nom extrait"}</h2>
        <p>{[payload.brand, payload.quantity, payload.ean && "EAN " + payload.ean].filter(Boolean).join(" · ") || "Identité à vérifier"}</p>
        <p>Prix proposé : <strong>{payload.price == null ? "non trouvé" : payload.price.toFixed(2) + " €"}</strong>
          {payload.source && <small> · source : {payload.source}</small>}</p>
        {payload.price == null && <p>Le prix n’a pas pu être relevé. Vérifiez que le produit est disponible et qu’un magasin est sélectionné sur la fiche, puis relancez la capture.</p>}
        <p>Page consultée : <a href={payload.url} target="_blank" rel="noreferrer">{payload.host}</a>. Le prix dépend du magasin et du canal choisis sur cette page.</p>
        {resolution.status === "loading" && <p role="status">Recherche de la référence V2…</p>}
        {resolution.status === "error" && <p role="alert">{resolution.message} Réessayez en rechargeant la page.</p>}
        {resolution.status === "no-ean" && <p role="alert">Aucun EAN vérifiable sur cette page. Recherchez le produit dans le <Link to="/v2/produits">catalogue</Link>, puis proposez son prix sur sa fiche.</p>}
        {resolution.status === "product" && resolution.product && <div className="v2-capture-match"><strong>Produit V2 trouvé :</strong> <Link to={"/v2/produits/" + resolution.id}>{[resolution.product.data.brand, resolution.product.data.name, resolution.product.data.quantity].filter(Boolean).join(" · ")}</Link></div>}
        {resolution.status === "draft" && resolution.draft && <div className="v2-capture-match"><strong>Votre brouillon pour cet EAN :</strong> <Link to={"/v2/brouillons/" + resolution.id}>{[resolution.draft.data.brand, resolution.draft.data.name, resolution.draft.data.quantity].filter(Boolean).join(" · ") || payload.ean}</Link><p>Le prix peut y être joint maintenant ; il sera examiné séparément après la publication de la fiche.</p></div>}
        {resolution.status === "missing" && <p>Ce produit n’est pas encore dans le catalogue. Cette action créera un brouillon privé avec l’EAN {payload.ean} et y joindra le prix en une seule soumission. Complétez la fiche avant sa validation si des informations manquent.</p>}
        {canContribute && (user ? <form onSubmit={event => void submit(event)}>
          <fieldset disabled={busy}>
            {resolution.status === "missing" && <div className="v2-price-fields"><h3>Fiche produit proposée</h3>
              <label>Nom<input maxLength={160} value={productFields.name} onChange={event => setProductFields({ ...productFields, name: event.target.value })} /></label>
              <label>Marque<input maxLength={100} value={productFields.brand} onChange={event => setProductFields({ ...productFields, brand: event.target.value })} /></label>
              <label>Conditionnement<input maxLength={160} value={productFields.package} onChange={event => setProductFields({ ...productFields, package: event.target.value })} placeholder="À compléter si connu" /></label>
              <label>Quantité<input maxLength={80} value={productFields.quantity} onChange={event => setProductFields({ ...productFields, quantity: event.target.value })} /></label>
              <p>Les champs manquants pourront être complétés dans le brouillon avant validation de la fiche.</p>
            </div>}
            <p>Indiquez le point de vente réellement sélectionné sur le site de l’enseigne. Il sera proposé à nouveau pour cette enseigne dans ce navigateur.</p>
            <div className="v2-price-fields">
              <label>Enseigne<input required maxLength={200} value={store.retailer} onChange={event => setStore({ ...store, retailer: event.target.value })} /></label>
              <label>Point de vente ou service<input required maxLength={300} value={store.store_name} onChange={event => setStore({ ...store, store_name: event.target.value })} /></label>
              <label>Ville ou zone desservie<input required maxLength={200} value={store.city} onChange={event => setStore({ ...store, city: event.target.value })} /></label>
              <label>Code postal<input maxLength={20} value={store.postal_code} onChange={event => setStore({ ...store, postal_code: event.target.value })} /></label>
              <label>Canal<select value={store.sales_channel} onChange={event => setStore({ ...store, sales_channel: event.target.value as Store["sales_channel"] })}>
                {Object.entries(channels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></label>
              <label>Prix du conditionnement, en €<input required type="number" min="0.01" max="99999999.99" step="0.01" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} /></label>
              <label>Date du relevé<input required type="date" max={today()} value={observedAt} onChange={event => setObservedAt(event.target.value)} /></label>
              <label>Précision facultative<input maxLength={1000} value={note} onChange={event => setNote(event.target.value)} />
                <small>Ce texte sera public après validation. Retirez l’URL si elle ne désigne pas une fiche publique.</small></label>
            </div>
            <label className="v2-capture-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
              J’ai vérifié l’EAN, les informations produit, le prix affiché et le point de vente sélectionné.</label>
          </fieldset>
          <button className="v2-button v2-button-primary" type="submit" disabled={busy || !confirmed}>{busy ? "Envoi…" : resolution.status === "missing" ? "Proposer la fiche et le prix" : resolution.status === "draft" ? "Joindre ce prix au brouillon" : "Proposer ce relevé"}</button>
          {error && <p role="alert" className="v2-price-error">{error}</p>}
        </form> : <p>Pour proposer ce relevé, <Link to="/v2/connexion?next=capture">connectez-vous</Link>. La capture reste dans cet onglet.</p>)}
      </>}
    </section>
  </Frame>;
}

async function submissionError(response: Response): Promise<Error> {
  const data: unknown = await response.json().catch(() => null);
  const detail = data && typeof data === "object" && "detail" in data ? (data as { detail?: unknown }).detail : null;
  return new Error(typeof detail === "string" ? detail : "Le relevé n’a pas été enregistré.");
}

export default function V2CapturePage({ mode, user, onLogout }: { mode: "install" | "review"; user: V2User | null; onLogout: () => Promise<void> }) {
  return mode === "install" ? <Install user={user} onLogout={onLogout} /> : <Review user={user} onLogout={onLogout} />;
}
