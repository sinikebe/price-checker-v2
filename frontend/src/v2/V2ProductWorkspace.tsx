import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import V2OffLookup from "./V2OffLookup";
import V2BarcodeSearch from "./V2BarcodeSearch";
import V2OffSnapshotPanel from "./V2OffSnapshotPanel";
import V2PriceHistory from "./V2PriceHistory";
import V2ReportControl from "./V2ReportControl";
import { useV2Basket } from "./V2BasketContext";
import {
  completeProductData, emptyProduct, productRequest, type ChangeKind, type Draft, type Product,
  type ProductData, type ProductEvent,
} from "./v2-products-api";
import "./v2-product-workspace.css";

type Mode = "catalogue" | "mine" | "review" | "new" | "edit" | "draft" | "detail" | "history";
type Props = { mode: Mode; id?: number; user: V2User | null; onLogout: () => Promise<void> };
const fields: { key: "brand" | "name" | "commercial_name" | "composition" | "package" | "quantity" | "ean" | "group" | "notes" | "nutriscore" | "nova" | "nutriscore_version"; label: string; hint?: string }[] = [
  { key: "brand", label: "Marque" },
  { key: "name", label: "Nom du produit" },
  { key: "commercial_name", label: "Nom commercial complet" },
  { key: "composition", label: "Composition", hint: "Si elle change, une nouvelle version du produit sera créée." },
  { key: "package", label: "Conditionnement", hint: "Ex. flacon souple" },
  { key: "quantity", label: "Quantité", hint: "Ex. 415 g ou 1 L" },
  { key: "ean", label: "Code EAN / GTIN", hint: "8, 12, 13 ou 14 chiffres, facultatif." },
  { key: "group", label: "Groupe comparable" },
  { key: "notes", label: "Notes", hint: "Précisions utiles sur cette référence." },
  { key: "nutriscore", label: "Nutri-Score", hint: "A à E, si connu." },
  { key: "nova", label: "NOVA", hint: "1 à 4, si connu." },
  { key: "nutriscore_version", label: "Version Nutri-Score", hint: "Ex. 2023, si connue." },
];

function localDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function safeProductUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? value : null; }
  catch { return null; }
}

export function Frame({ children, user, onLogout }: { children: React.ReactNode; user: V2User | null; onLogout: () => Promise<void> }) {
  return <div className="v2-home v2-workspace">
    <a className="v2-skip" href="#v2-workspace-main">Aller au contenu</a>
    <header className="v2-header"><div className="v2-wrap v2-header-inner">
      <Link className="v2-brand" to="/v2"><span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
        <span>price<span className="v2-brand-accent">checker</span><span className="v2-brand-period">.</span></span></Link>
      <nav className="v2-nav" aria-label="Navigation principale">
        <Link to="/v2">Accueil</Link><Link to="/v2/produits">Produits</Link><Link to="/v2/recettes">Recettes</Link><Link to="/v2/panier">Panier</Link><Link to="/v2/parametres">Paramètres</Link>
        <Link to="/v2/produits/nouveau">Ajouter</Link><Link to="/v2/capture/installer">Capturer un prix <span className="v2-beta-tag">Bêta</span></Link>
        {user && <Link to="/v2/brouillons">Mes brouillons</Link>}
        {user?.role === "admin" && <Link to="/v2/moderation">À valider</Link>}
        {user ? <span className="v2-account-nav"><span>{user.username}</span><button onClick={() => { void onLogout(); }}>Déconnexion</button></span>
          : <span className="v2-account-nav"><Link to="/v2/connexion">Connexion</Link></span>}
      </nav>
    </div></header>
    <main id="v2-workspace-main" className="v2-wrap v2-workspace-main">{children}</main>
  </div>;
}

function useCollection<T>(path: string, enabled = true) {
  const [result, setResult] = useState<{ path: string; data: T | null; error: string }>({ path: "", data: null, error: "" });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    productRequest<T>(path).then(value => { if (active) setResult({ path, data: value, error: "" }); })
      .catch(reason => { if (active) setResult({ path, data: null, error: String(reason) }); });
    return () => { active = false; };
  }, [path, enabled, reload]);
  return { data: enabled && result.path === path ? result.data : null,
    error: enabled && result.path === path ? result.error : "",
    refresh: () => setReload(value => value + 1) };
}

function ListPage({ mode, user, onLogout }: Props) {
  const [page, setPage] = useState(0);
  const pageSize = 30;
  const path = mode === "mine" ? "/drafts/mine" : mode === "review" ? `/drafts/review?limit=${pageSize}&offset=${page * pageSize}` : "";
  const { data, error } = useCollection<(Draft | Product)[]>(path, mode !== "review" || user?.role === "admin");
  const title = mode === "mine" ? "Mes brouillons" : mode === "review" ? "Propositions à valider" : "Produits publiés";
  return <Frame user={user} onLogout={onLogout}>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">CATALOGUE V2</span><h1>{title}<span>.</span></h1>
      <p>{mode === "mine" ? "Vos propositions restent privées jusqu'à validation." : mode === "review" ? "Vérifiez chaque proposition avant publication." : "Seuls les produits validés sont visibles ici."}</p></div>
      <Link className="v2-button v2-button-primary" to="/v2/produits/nouveau">Ajouter un produit →</Link>
    </div>
    {mode === "catalogue" && <V2BarcodeSearch />}
    {mode === "review" && user?.role !== "admin" ? <p role="alert">Accès réservé à l'administrateur.</p> :
      error ? <p role="alert">{error}</p> : !data ? <p>Chargement…</p> : data.length === 0 ? <div className="v2-workspace-empty">Aucun {mode === "catalogue" ? "produit publié" : "brouillon"} pour le moment.</div> :
      <div className="v2-workspace-list">{data.map(item => {
        const draft = "status" in item;
        const href = draft ? "/v2/brouillons/" + item.id : "/v2/produits/" + item.id;
        return <Link key={item.id} to={href} className="v2-workspace-list-item">
          <div><strong>{item.data.brand} {item.data.name || "Produit sans nom"}</strong>
            <small>{item.data.quantity || "Quantité à préciser"} · {draft ? item.status === "rejected" ? "Rejeté" : item.product_id ? "Modification" : "Nouveau produit" : "Publié"}</small></div>
          <span>{draft ? "Voir le brouillon" : "Voir la fiche"} →</span>
        </Link>;
      })}</div>}
    {mode === "review" && data && (page > 0 || data.length === pageSize) && <div className="v2-settings-actions">
      <button type="button" className="v2-button v2-button-secondary" disabled={page === 0}
        onClick={() => setPage(value => Math.max(0, value - 1))}>Précédent</button>
      <span>Page {page + 1}</span>
      <button type="button" className="v2-button v2-button-secondary" disabled={data.length < pageSize}
        onClick={() => setPage(value => value + 1)}>Suivant</button>
    </div>}
  </Frame>;
}

function localRead(key: string): { data: ProductData; change_kind: ChangeKind; revision: number | null } | null {
  try {
    const value = localStorage.getItem(key);
    if (!value) return null;
    const parsed = JSON.parse(value);
    return { data: completeProductData(parsed.data), change_kind: parsed.change_kind === "new_version" ? "new_version" : "correction",
      revision: Number.isInteger(parsed.revision) && parsed.revision > 0 ? parsed.revision : null };
  } catch { return null; }
}

function Editor({ mode, id, user, onLogout }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryBarcode = new URLSearchParams(location.search).get("ean") ?? "";
  const initialBarcode = mode === "new" && /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(queryBarcode) ? queryBarcode : "";
  const localKey = mode === "new" ? "v2:product:new" + (user ? ":" + user.id : "") + (initialBarcode ? ":ean:" + initialBarcode : "") : mode === "edit" ? "v2:product:edit:" + (user?.id ?? "anon") + ":" + id : "v2:product:draft:" + (user?.id ?? "anon") + ":" + id;
  const [data, setData] = useState<ProductData>(() => localRead(localKey)?.data ?? { ...emptyProduct(), ean: initialBarcode });
  const [changeKind, setChangeKind] = useState<ChangeKind>(() => localRead(localKey)?.change_kind ?? "correction");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseRevision, setBaseRevision] = useState<number | null>(() => localRead(localKey)?.revision ?? null);
  const [baseProduct, setBaseProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(mode !== "new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [localError, setLocalError] = useState("");
  const localVersion = useRef(0);
  const [dirty, setDirty] = useState(Boolean(localRead(localKey)));
  const [tagInput, setTagInput] = useState("");
  const [retailerInput, setRetailerInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  useEffect(() => {
    if (mode === "new" || !id) return;
    let active = true;
    if (mode === "draft") {
      productRequest<Draft>("/drafts/" + id).then(value => {
        if (!active) return;
        if (value.status === "approved" && value.result_product_id) {
          localStorage.removeItem(localKey);
          navigate("/v2/produits/" + value.result_product_id, { replace: true });
          return;
        }
        setDraft(value);
        if (!localRead(localKey)) { setData(completeProductData(value.data)); setChangeKind(value.change_kind); setBaseRevision(value.revision); setDirty(false); }
        setLoading(false);
      }).catch(reason => { if (active) { setError(String(reason)); setLoading(false); } });
    } else {
      Promise.all([
        productRequest<Product>("/" + id),
        user ? productRequest<Draft[]>("/drafts/mine") : Promise.resolve([]),
      ]).then(([value, myDrafts]) => {
        if (!active) return;
        const existing = myDrafts.find(item => item.product_id === id);
        if (existing) {
          const unsaved = localRead(localKey);
          if (unsaved) localStorage.setItem("v2:product:draft:" + user?.id + ":" + existing.id, JSON.stringify(unsaved));
          navigate("/v2/brouillons/" + existing.id, { replace: true });
          return;
        }
        if (value.successor_id && !localRead(localKey)) {
          navigate("/v2/produits/" + value.successor_id + "/modifier", { replace: true });
          return;
        }
        setBaseProduct(value);
        if (!localRead(localKey)) { setData(completeProductData(value.data)); setDirty(false); }
        setLoading(false);
      }).catch(reason => { if (active) { setError(String(reason)); setLoading(false); } });
    }
    return () => { active = false; };
  }, [mode, id, localKey, user, navigate]);

  function persist(next: ProductData, kind: ChangeKind, fromOff = false) {
    if (!fromOff && next.off_source) {
      const changed = fields.filter(field => data[field.key] !== next[field.key]).map(field => field.key);
      const kept = next.off_source.fields.filter(key =>
        !changed.includes(key) && !(key === "nutriscore" && changed.includes("nutriscore_version"))
      );
      next = { ...next, off_source: kept.length ? { ...next.off_source, fields: kept } : null };
      if (changed.includes("nutriscore")) next.nutriscore_version = "";
    }
    if (next.quantity !== data.quantity) next = { ...next, quantity_amount: null, quantity_unit: null, quantity_count_noun: null };
    setData(next); setChangeKind(kind); setDirty(true); localVersion.current += 1;
    try {
      localStorage.setItem(localKey, JSON.stringify({ data: next, change_kind: kind, revision: draft ? baseRevision : null }));
      setLocalError("");
    } catch { setLocalError("Stockage local indisponible : copiez vos informations avant de quitter la page."); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!user) { setError("Connectez-vous pour enregistrer ce brouillon sur le serveur. Votre saisie reste dans ce navigateur."); return; }
    if (draft?.successor_id || baseProduct?.successor_id) {
      setError("Cette référence a été remplacée. Proposez une modification de la version actuelle.");
      return;
    }
    if (draft && baseRevision !== draft.revision) {
      setError("Ce brouillon a changé ailleurs. Choisissez comment résoudre le conflit avant de l’enregistrer.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    const snapshot = localVersion.current;
    try {
      if (draft) {
        const saved = await productRequest<Draft>("/drafts/" + draft.id, "PUT", { revision: baseRevision, data, change_kind: changeKind });
        setDraft(saved); setBaseRevision(saved.revision);
        if (snapshot === localVersion.current) { localStorage.removeItem(localKey); setDirty(false); }
        setNotice("Brouillon enregistré sur le serveur. Vous le retrouverez sur vos autres navigateurs.");
      } else {
        const saved = await productRequest<Draft>("/drafts", "POST", { product_id: mode === "edit" ? id : null, data, change_kind: changeKind });
        if (snapshot === localVersion.current) localStorage.removeItem(localKey);
        navigate("/v2/brouillons/" + saved.id);
      }
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const conflict = Boolean(draft && dirty && baseRevision !== draft.revision);
  const successorId = draft?.successor_id ?? baseProduct?.successor_id;
  const isReview = mode === "draft" && draft && user?.role === "admin" && draft.author_id !== user.id;
  const readonly = Boolean(isReview || draft?.status === "rejected");
  async function approve() {
    if (!draft || busy || dirty || successorId) return;
    setBusy(true); setError("");
    try {
      const product = await productRequest<Product>("/drafts/" + draft.id + "/approve", "POST", { revision: draft.revision });
      navigate("/v2/produits/" + product.id);
    } catch (reason) { setError(String(reason)); setBusy(false); }
  }
  async function reject() {
    if (!draft || busy || dirty || draft.status !== "draft") return;
    if (!window.confirm("Rejeter cette proposition ?")) return;
    setBusy(true); setError("");
    try {
      const rejected = await productRequest<Draft>("/drafts/" + draft.id + "/reject", "POST", { revision: draft.revision });
      setDraft(rejected);
      setNotice("Proposition rejetée. Elle reste visible pour son auteur.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function discardSuperseded() {
    if (!draft || (!successorId && draft.status !== "rejected") || draft.author_id !== user?.id || busy) return;
    if (!window.confirm("Abandonner cet ancien brouillon ? Recopiez d’abord les informations utiles dans une proposition sur la version actuelle.")) return;
    setBusy(true); setError("");
    try {
      await productRequest<{ deleted: boolean }>("/drafts/" + draft.id, "DELETE");
      localStorage.removeItem(localKey);
      navigate("/v2/brouillons");
    } catch (reason) { setError(String(reason)); setBusy(false); }
  }
  return <Frame user={user} onLogout={onLogout}>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">CONTRIBUTION · {mode === "new" ? "NOUVEAU PRODUIT" : "BROUILLON"}</span>
      <h1>{mode === "new" ? "Ajouter un produit" : mode === "edit" ? "Modifier un produit" : "Votre proposition"}<span>.</span></h1>
      <p>La saisie est enregistrée dans ce navigateur à chaque modification. « Enregistrer » la rend disponible après connexion sur vos autres appareils. Seul un administrateur peut publier. Les textes et liens seront publics après validation : évitez les informations personnelles.</p></div>
      <Link className="v2-button v2-button-secondary" to="/v2/brouillons">Mes brouillons</Link>
    </div>
    {draft?.status === "rejected" && <div role="status"><p>Cette proposition a été rejetée. Elle ne peut plus être publiée ni modifiée.</p><button className="v2-button v2-button-secondary" type="button" disabled={busy} onClick={() => { void discardSuperseded(); }}>Supprimer ce brouillon rejeté</button></div>}
    {successorId && draft?.status !== "rejected" && <div role="alert"><p>Cette référence possède déjà une version plus récente. Votre ancien brouillon reste consultable pour recopier vos changements, mais ne peut plus être publié. <Link to={"/v2/produits/" + successorId + "/modifier"}>Proposer une modification de la version actuelle →</Link></p>
      {draft && draft.author_id === user?.id && <button className="v2-button v2-button-secondary" type="button" disabled={busy} onClick={() => { void discardSuperseded(); }}>Abandonner cet ancien brouillon</button>}
    </div>}
    {loading ? <p>Chargement…</p> : error && !draft && !baseProduct && mode !== "new" ? <p role="alert">{error}</p> :
    <div className="v2-workspace-editor-layout">
      <form className="v2-workspace-card" onSubmit={save}>
        <h2>{draft ? "Brouillon serveur #" + draft.id : "Informations produit"}</h2>
        <fieldset disabled={busy || readonly}>
          <div className="v2-workspace-fields">{fields.map(field => <label key={field.key}>
            <span>{field.label}</span>
            {field.key === "composition" || field.key === "notes" ? <textarea value={data[field.key]} onChange={event => persist({ ...data, [field.key]: event.target.value }, changeKind)} rows={5} /> :
              <input value={data[field.key]} onChange={event => persist({ ...data, [field.key]: event.target.value }, changeKind)} />}
            {field.hint && <small>{field.hint}</small>}
          </label>)}</div>
          <div className="v2-workspace-structured"><h3>Étiquettes du groupe</h3>
            <p>Plusieurs étiquettes peuvent décrire le même groupe comparable.</p>
            <ul>{data.tags.map(tag => <li key={tag}>{tag} <button type="button" onClick={() => persist({ ...data, tags: data.tags.filter(item => item !== tag) }, changeKind)}>Retirer</button></li>)}</ul>
            <label>Nouvelle étiquette <input value={tagInput} onChange={event => setTagInput(event.target.value)} maxLength={100} /></label>
            <button type="button" onClick={() => { const tag = tagInput.trim(); if (tag && data.group.trim() && !data.tags.some(item => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) persist({ ...data, tags: [...data.tags, tag] }, changeKind); setTagInput(""); }}>Ajouter l’étiquette</button>
            {!data.group.trim() && <small>Renseignez d’abord le groupe.</small>}
          </div>
          <div className="v2-workspace-structured"><h3>Fiches par enseigne</h3>
            <ul>{data.retailer_links.map(link => <li key={link.retailer}><strong>{link.retailer}</strong> · {link.source === "capture" ? "capture" : "saisie manuelle"} · {safeProductUrl(link.url) ? <a href={link.url} target="_blank" rel="noopener noreferrer">Voir la fiche ↗</a> : "Lien invalide"} {user?.role === "admin" && <small style={{ overflowWrap: "anywhere" }}>Destination : {link.url}</small>} <button type="button" onClick={() => persist({ ...data, retailer_links: data.retailer_links.filter(item => item.retailer !== link.retailer) }, changeKind)}>Retirer</button></li>)}</ul>
            <label>Enseigne <input value={retailerInput} onChange={event => setRetailerInput(event.target.value)} maxLength={100} /></label>
            <label>URL de la fiche <input type="url" value={urlInput} onChange={event => setUrlInput(event.target.value)} maxLength={1000} /></label>
            <button type="button" onClick={() => { const retailer = retailerInput.trim(); const url = urlInput.trim(); if (!retailer || !/^https?:\/\//i.test(url)) return; persist({ ...data, retailer_links: [...data.retailer_links.filter(link => link.retailer.toLocaleLowerCase() !== retailer.toLocaleLowerCase()), { retailer, url, source: "manual" }] }, changeKind); setRetailerInput(""); setUrlInput(""); }}>Ajouter ou remplacer le lien</button>
          </div>
          <label>Dernier contrôle nutritionnel <input type="datetime-local" value={localDateTime(data.nutrition_checked_at)} onChange={event => persist({ ...data, nutrition_checked_at: event.target.value ? new Date(event.target.value).toISOString() : null }, changeKind)} /></label>
          <small>Cette date est distincte de la récupération de la fiche Open Food Facts.</small>
          <p>Quantité analysée : {data.quantity_amount && data.quantity_unit ? `${data.quantity_amount} ${data.quantity_unit}${data.quantity_count_noun ? ` (${data.quantity_count_noun})` : ""}` : data.quantity ? "à analyser lors de l’enregistrement" : "à renseigner"}.</p>
          {(mode === "edit" || draft?.product_id) && <fieldset className="v2-workspace-kind"><legend>Nature de la modification</legend>
            <label><input type="radio" checked={changeKind === "correction"} onChange={() => persist(data, "correction")} /> Correction de la fiche existante</label>
            <label><input type="radio" checked={changeKind === "new_version"} onChange={() => persist(data, "new_version")} /> Nouvelle version de la référence vendue</label>
          </fieldset>}
        </fieldset>
        <V2OffLookup data={data} disabled={busy || readonly}
          onApply={next => persist(next, changeKind, true)} />
        {conflict && draft && <div className="v2-workspace-conflict" role="alert">
          <strong>Conflit de brouillon.</strong> Votre saisie locale repose sur une version différente de celle du serveur.
          Aucune modification n’a été envoyée. Version locale : {baseRevision ?? "inconnue"} ; version serveur : {draft.revision}.
          <p>Comparez les deux versions avant de choisir. La version serveur s’intitule « {draft.data.name || "Produit sans nom"} ».</p>
          <details><summary>Voir les champs enregistrés sur le serveur</summary>
            <dl>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{draft.data[field.key] || "—"}</dd></div>)}</dl>
          </details>
          <button type="button" disabled={busy} onClick={() => {
            setData(completeProductData(draft.data)); setChangeKind(draft.change_kind); setBaseRevision(draft.revision);
            setDirty(false); setError(""); localStorage.removeItem(localKey);
          }}>Charger la version serveur</button>
          <button type="button" disabled={busy} onClick={() => {
            setBaseRevision(draft.revision); setError("");
            setNotice("Votre saisie locale est conservée. Cliquez sur Enregistrer pour remplacer la version serveur.");
            try {
              localStorage.setItem(localKey, JSON.stringify({ data, change_kind: changeKind, revision: draft.revision }));
              setLocalError("");
            } catch { setLocalError("Stockage local indisponible : copiez vos informations avant de quitter la page."); }
          }}>Préparer le remplacement avec ma saisie</button>
        </div>}
        <div className="v2-workspace-actions">
          {!readonly && <button className="v2-button v2-button-primary" disabled={busy || conflict || Boolean(successorId)} type="submit">{busy ? "Enregistrement…" : "Enregistrer le brouillon sur le serveur"}</button>}
          {draft?.status === "draft" && user?.role === "admin" && <><button className="v2-button v2-button-secondary" type="button" disabled={busy || dirty || Boolean(successorId)} onClick={() => { void approve(); }}>Valider et publier</button><button className="v2-button v2-button-secondary" type="button" disabled={busy || dirty} onClick={() => { void reject(); }}>Rejeter</button></>}
        </div>
        {dirty && draft && user?.role === "admin" && <p>Enregistrez vos changements locaux avant de valider.</p>}
        {localError && <p role="alert">{localError}</p>}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!user && <p>Sans connexion, le brouillon reste sur ce navigateur. <Link to="/v2/connexion">Se connecter</Link></p>}
      </form>
      <aside className="v2-workspace-card v2-workspace-aside"><h2>Visibilité</h2>
        <p>{draft ? "Ce brouillon est visible par son auteur et les administrateurs." : "La saisie locale n'est visible que dans ce navigateur."}</p>
        <p>Le produit public {baseProduct || draft?.product_id ? "reste inchangé tant que la proposition n'est pas validée." : "n'apparaîtra qu'après validation."}</p>
        <p>Un changement de composition ou de format exige une nouvelle version liée à l'ancienne fiche.</p>
        {draft?.linked_prices && draft.linked_prices.length > 0 && <div><h3>Prix joints à cette fiche</h3>
          <ul>{draft.linked_prices.map(item => <li key={item.id}>{Number(item.price).toFixed(2)} € · {item.retailer} · {item.store_name}
            {item.quantity_text && ` · ${item.quantity_text}`}
            {item.capture_ean && ` · EAN ${item.capture_ean}`}
            {item.captured_store_name && ` · nom de la page : ${item.captured_store_name}`}
            {` · ${item.status === "draft" ? "En attente" : item.status === "approved" ? "Validé" : "Refusé"}`}</li>)}</ul>
          <p>La fiche doit être publiée avant que ces prix puissent être validés séparément.</p></div>}
        {data.off_source && <p>Source consultée : <a href={"https://world.openfoodfacts.org/product/" + data.off_source.code}
          target="_blank" rel="noreferrer">Open Food Facts · {data.off_source.code} ↗</a><br />
          Champs repris : {data.off_source.fields.join(", ")}.</p>}
      </aside>
    </div>}
  </Frame>;
}

function Detail({ mode, id, user, onLogout }: Props) {
  const basket = useV2Basket();
  const { data: product, error } = useCollection<Product>("/" + id);
  const { data: events } = useCollection<ProductEvent[]>("/" + id + "/history", mode === "history");
  useLayoutEffect(() => { if (product) window.scrollTo(0, 0); }, [id, product]);
  if (error) return <Frame user={user} onLogout={onLogout}><p role="alert">{error}</p></Frame>;
  if (!product) return <Frame user={user} onLogout={onLogout}><p>Chargement…</p></Frame>;
  const d = completeProductData(product.data);
  return <Frame user={user} onLogout={onLogout}>
    <div className="v2-workspace-heading"><div><span className="v2-section-kicker">PRODUIT PUBLIÉ · V2</span><h1>{d.brand} {d.name}<span>.</span></h1>
      <p>{d.commercial_name || d.quantity}</p></div>
      <div className="v2-recipes-actions"><button type="button" className="v2-button v2-button-primary" onClick={() => product && (basket.has(product.id) ? basket.remove(product.id) : basket.add(product))}>{basket.has(product.id) ? "Retirer du panier" : "Ajouter au panier"}</button><Link className="v2-button v2-button-secondary" to={"/v2/produits/" + (product.successor_id ?? id) + "/modifier"}>Proposer une modification</Link></div>
    </div>
    <nav className="v2-workspace-subnav"><Link to={"/v2/produits/" + id}>Fiche</Link><Link to={"/v2/produits/" + id + "/historique"}>Historique</Link></nav>
    {mode === "history" ? <div className="v2-workspace-card"><h2>Historique des modifications</h2>
      {!events ? <p>Chargement…</p> : events.length === 0 ? <p>Aucune modification.</p> : events.map(event =>
        <article key={event.id} className="v2-workspace-event"><strong>{event.event_type === "created" ? "Création" : event.event_type === "new_version" ? "Nouvelle version" : event.event_type === "superseded" ? "Remplacé par une nouvelle version" : "Correction"}</strong>
          <span> · {new Date(event.created_at + "T12:00:00").toLocaleDateString("fr-FR")}</span>
          {event.before && <ul>{fields.filter(field => event.before?.[field.key] !== event.after[field.key]).map(field =>
            <li key={field.key}><strong>{field.label} :</strong> {event.before?.[field.key] || "—"} → {event.after[field.key] || "—"}</li>)}
            {JSON.stringify(event.before.tags) !== JSON.stringify(event.after.tags) &&
              <li><strong>Étiquettes :</strong> {completeProductData(event.before).tags.join(", ") || "—"} → {completeProductData(event.after).tags.join(", ") || "—"}</li>}
            {JSON.stringify(event.before.retailer_links) !== JSON.stringify(event.after.retailer_links) &&
              <li><strong>Liens d’enseigne :</strong> modification</li>}
            {event.before.nutrition_checked_at !== event.after.nutrition_checked_at &&
              <li><strong>Contrôle nutritionnel :</strong> {event.before.nutrition_checked_at || "—"} → {event.after.nutrition_checked_at || "—"}</li>}
            {JSON.stringify(event.before.off_source) !== JSON.stringify(event.after.off_source) &&
              <li><strong>Source OFF :</strong> {event.before.off_source?.code || "—"} → {event.after.off_source?.code || "—"}</li>}</ul>}
        </article>)}</div> :
      <div className="v2-workspace-card"><h2>Fiche produit</h2><dl className="v2-workspace-facts">
        {fields.filter(field => d[field.key]).map(field => <div key={field.key}><dt>{field.label}</dt><dd>{d[field.key]}</dd></div>)}</dl>
        {d.group && <p><Link to={"/v2/categories/" + encodeURIComponent(d.group)}>Voir les produits du groupe « {d.group} » →</Link></p>}
        {d.tags.length > 0 && <p><strong>Étiquettes du groupe :</strong> {d.tags.join(" · ")}</p>}
        {d.nutrition_checked_at && <p><strong>Dernier contrôle nutritionnel :</strong> {new Date(d.nutrition_checked_at).toLocaleString("fr-FR")}</p>}
        {d.quantity_amount && d.quantity_unit && <p><strong>Quantité analysée :</strong> {d.quantity_amount} {d.quantity_unit}{d.quantity_count_noun && ` (${d.quantity_count_noun})`}</p>}
        {d.retailer_links.length > 0 && <section><h3>Fiches par enseigne</h3><ul>{d.retailer_links.map(link => <li key={link.retailer}>{safeProductUrl(link.url) ? <a href={link.url} target="_blank" rel="noopener noreferrer">{link.retailer} ↗</a> : link.retailer} · {link.source === "capture" ? "source : capture" : "source : saisie manuelle"}</li>)}</ul></section>}
        {d.off_source && <p>Source consultée : <a href={"https://world.openfoodfacts.org/product/" + d.off_source.code}
          target="_blank" rel="noreferrer">Open Food Facts · {d.off_source.code} ↗</a></p>}
        {product.predecessor_id && <p><Link to={"/v2/produits/" + product.predecessor_id}>Voir la version précédente →</Link></p>}
        {product.successor_id && <p><Link to={"/v2/produits/" + product.successor_id}>Voir la version actuelle →</Link></p>}
      </div>}
    {mode !== "history" && id && <V2PriceHistory key={`${id}:${user?.id ?? "visitor"}`} productId={id} user={user} current={!product.successor_id} />}
    {mode !== "history" && id && <V2OffSnapshotPanel productId={id} ean={d.ean} user={user} />}
    {id && <V2ReportControl kind="product" contentId={id} user={user} />}
  </Frame>;
}

export default function V2ProductWorkspace(props: Props) {
  const location = useLocation();
  if (["catalogue", "mine", "review"].includes(props.mode)) return <ListPage key={props.mode + ":" + (props.user?.id ?? "anon")} {...props} />;
  if (["new", "edit", "draft"].includes(props.mode)) return <Editor key={props.mode + ":" + props.id + ":" + (props.user?.id ?? "anon") + (props.mode === "new" ? ":" + location.search : "")} {...props} />;
  return <Detail {...props} />;
}
