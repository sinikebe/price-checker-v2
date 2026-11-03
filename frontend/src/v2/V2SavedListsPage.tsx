import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import V2SiteHeader from "./V2SiteHeader";
import { useV2Basket, type BasketApi } from "./V2BasketContext";
import type { V2User } from "./v2-auth-api";
import { currentBasketProduct } from "./v2-basket-product";
import type { BasketItem } from "./v2-basket-storage";
import { money } from "./v2-basket-view";
import { productRequest, type Product } from "./v2-products-api";
import { lineCount, type SavedList, type SavedListLine } from "./v2-saved-lists";
import { SHARED_BASKET_PATH } from "./v2-shared-basket";
import "./v2-recipes.css";
import "./v2-shared-basket.css";
import "./v2-shopping-list.css";

const day = (value: string) => new Date(value).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? "s" : ""}`;

function Status({ offline, waiting, error, onClose }: { offline: boolean; waiting: number; error: string; onClose: () => void }) {
  return <>
    {(offline || waiting > 0) && <p className="v2-shared-offline" role="status">{offline
      ? "Hors connexion : vos listes restent consultables et modifiables ; les changements partent dès le retour de la connexion."
      : "Envoi des changements…"}{waiting > 0 && ` ${plural(waiting, "changement")} en attente.`}</p>}
    {error && <p role="alert" className="v2-recipes-error">{error} <button type="button" className="v2-basket-remove" onClick={onClose}>Fermer</button></p>}
  </>;
}

function Overview({ lists }: { lists: SavedList[] }) {
  if (!lists.length) return <div className="v2-recipes-card"><p>Aucune liste enregistrée. Depuis un panier, comparez les prix, ouvrez la <strong>Liste de courses</strong> puis choisissez <strong>Enregistrer la liste</strong>.</p>
    <Link className="v2-button v2-button-secondary" to="/v2/panier">Aller au panier</Link></div>;
  return <ul className="v2-saved-lists">{lists.map(list => {
    const total = lineCount(list), done = list.checked.length;
    const stores = list.content.sections.flatMap(section => section.retailer ? [section.retailer] : []);
    return <li key={list.id}><Link to={`/v2/listes/${list.id}`} className="v2-recipes-tile">
      <strong>{list.name}</strong>
      <span>{plural(total, "article")} · {done}/{total} coché{done > 1 ? "s" : ""}{stores.length ? ` · ${stores.join(", ")}` : ""}</span>
      <span>Enregistrée le {day(list.created_at)}{list.content.source === "shared" && list.content.source_name ? ` · panier partagé « ${list.content.source_name} »` : ""}</span>
    </Link></li>;
  })}</ul>;
}

function Line({ line, checked, onCheck }: { line: SavedListLine; checked: boolean; onCheck: (on: boolean) => void }) {
  return <li className="v2-list-line" data-checked={checked} data-missing={!!line.missing}>
    <label><input type="checkbox" checked={checked} onChange={event => onCheck(event.target.checked)} />
      <span className="v2-list-line-text"><strong>{line.packages && line.packages > 1 ? `${line.packages} × ` : ""}{line.label}</strong>
        {(line.detail || line.missing) && <small>{[line.missing ? "pas de prix ici au moment de l’enregistrement" : null, line.detail || null].filter(Boolean).join(" · ")}</small>}</span>
      {line.cents != null && <span className="v2-list-line-price">{money(line.cents)}</span>}
    </label>
  </li>;
}

/** The articles of a saved list as basket items: products are looked up again (a newer version, if any). */
async function basketItems(lines: SavedListLine[]): Promise<{ items: BasketItem[]; unavailable: string[] }> {
  const items: BasketItem[] = [], unavailable: string[] = [];
  for (const line of lines) {
    const ref = line.line, quantity = line.quantity ?? undefined;
    if (!ref) { unavailable.push(line.label); continue; }
    if (ref.kind === "group") items.push({ kind: "group", name: ref.name, quantity });
    else if (ref.kind === "scope") items.push({ kind: "scope", name: ref.name, department: ref.department, family: ref.family, quantity });
    else {
      const product = await currentBasketProduct(ref.product_id, null, id => productRequest<Product>("/" + id));
      if (product) items.push({ id: product.id, data: product.data, revision: product.revision, quantity }); else unavailable.push(line.label);
    }
  }
  return { items, unavailable };
}

function Detail({ list }: { list: SavedList }) {
  const basket = useV2Basket();
  const { lists } = basket;
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(list.name);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const ticked = new Set(list.checked);
  const keys = new Set(list.content.sections.flatMap(section => section.lines.map(line => line.key)));
  const check = (key: string, on: boolean) => lists.setChecked(list.id, [...list.checked.filter(value => value !== key && keys.has(value)), ...(on ? [key] : [])]);
  async function putBack(target: BasketApi, where: string, path: string) {
    setBusy(true); setNotice("");
    try {
      const { items, unavailable } = await basketItems(list.content.sections.flatMap(section => section.lines));
      const added = target.merge(items);
      setNotice(`${plural(added, "article")} ajouté${added > 1 ? "s" : ""} ${where} ; ceux qui y étaient déjà sont restés tels quels.`
        + (unavailable.length ? ` Indisponible${unavailable.length > 1 ? "s" : ""} : ${unavailable.join(", ")}.` : ""));
      if (added) navigate(path);
    } catch { setNotice("Impossible de retrouver les produits, sans doute hors connexion. Aucun article n’a été ajouté."); }
    finally { setBusy(false); }
  }
  return <>
    <div className="v2-list-toolbar">
      <Link className="v2-button v2-button-secondary" to="/v2/listes">← Listes</Link>
      <button type="button" className="v2-button v2-button-secondary" disabled={!list.checked.length} onClick={() => lists.setChecked(list.id, [])}>Tout décocher</button>
      <button type="button" className="v2-button v2-button-secondary" onClick={() => { setName(list.name); setRenaming(!renaming); }}>Renommer</button>
      <button type="button" className="v2-button v2-button-secondary" disabled={busy} onClick={() => void putBack(basket, "à votre panier", "/v2/panier")}>Remettre dans mon panier</button>
      {basket.sharedBasket && <button type="button" className="v2-button v2-button-secondary" disabled={busy}
        onClick={() => void putBack(basket.sharedBasket!, "au panier partagé", SHARED_BASKET_PATH)}>Dans le panier partagé</button>}
    </div>
    {renaming && <form className="v2-list-save" onSubmit={event => { event.preventDefault(); if (name.trim()) { lists.rename(list.id, name.trim()); setRenaming(false); } }}>
      <label>Nom de la liste<input value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></label>
      <div className="v2-list-toolbar"><button type="submit" className="v2-button v2-button-primary" disabled={!name.trim()}>Enregistrer</button>
        <button type="button" className="v2-button v2-button-secondary" onClick={() => setRenaming(false)}>Annuler</button></div>
    </form>}
    {notice && <p role="status" className="v2-list-saved">{notice}</p>}
    <p className="v2-list-note">Enregistrée le {day(list.created_at)}{list.content.source === "shared" && list.content.source_name ? ` depuis le panier partagé « ${list.content.source_name} »` : " depuis votre panier"}
      {list.content.fetched_at ? `, prix relevés le ${day(list.content.fetched_at)}` : ""}. Une liste enregistrée ne suit plus le panier.</p>
    {list.content.sections.map((section, index) => {
      const done = section.lines.filter(line => ticked.has(line.key)).length;
      return <section key={index} className={"v2-list-section" + (section.retailer ? "" : " v2-list-missing")} aria-label={section.retailer ?? "Sans prix"}>
        <header><div><h2>{section.retailer ?? "Sans prix dans les magasins comparés"}</h2>{section.store && <p>{section.store}</p>}</div>
          {section.retailer && <div className="v2-list-section-total"><strong>{money(section.cents ?? 0)}</strong><small>{done}/{section.lines.length} pris</small></div>}</header>
        <ul>{section.lines.map(line => <Line key={line.key} line={line} checked={ticked.has(line.key)} onCheck={on => check(line.key, on)} />)}</ul>
      </section>;
    })}
    <section className="v2-list-delete">
      <p className="v2-shared-warning">Supprimer cette liste l’efface du serveur et de vos appareils. <strong>Cette suppression est définitive : elle ne peut pas être annulée.</strong></p>
      <button type="button" className="v2-button v2-shared-danger" onClick={() => {
        if (window.confirm(`Supprimer la liste « ${list.name} » ?\n\nCette suppression est définitive : elle ne peut pas être annulée.`)) { lists.remove(list.id); navigate("/v2/listes"); }
      }}>Supprimer la liste</button>
    </section>
  </>;
}

/** The shopping lists this account saved (/v2/listes), and one of them (/v2/listes/<id>). */
export default function V2SavedListsPage({ user, onLogout, listId }: { user: V2User | null; onLogout: () => Promise<void>; listId?: string }) {
  const { lists } = useV2Basket();
  const list = listId ? lists.lists.find(item => item.id === listId) ?? null : null;
  return <div className="v2-home v2-recipes">
    <a className="v2-skip" href="#v2-lists-main">Aller au contenu</a>
    <V2SiteHeader user={user} onLogout={onLogout} />
    <main id="v2-lists-main" className="v2-wrap v2-recipes-main">
      <div className="v2-recipes-heading"><div><span className="v2-section-kicker">LISTES ENREGISTRÉES</span><h1>{list ? list.name : "Mes listes"}<span>.</span></h1>
        {!list && <p>Vos listes de courses enregistrées, sur tous vos appareils et hors connexion.</p>}</div></div>
      {!user ? <div className="v2-recipes-card"><p>Connectez-vous pour enregistrer des listes de courses et les retrouver sur vos appareils.</p>
        <Link className="v2-button v2-button-primary" to="/v2/connexion">Se connecter</Link></div> : <>
        <Status offline={lists.offline} waiting={lists.waiting} error={lists.error} onClose={lists.clearError} />
        {listId ? list ? <Detail key={list.id} list={list} />
          : <div className="v2-recipes-card"><p>Cette liste n’existe plus sur cet appareil : elle a peut-être été supprimée.</p><Link to="/v2/listes">Toutes mes listes</Link></div>
          : <Overview lists={lists.lists} />}
      </>}
    </main>
  </div>;
}
