import { useContext } from "react";
import { Link } from "react-router-dom";
import { BasketLinksContext } from "./v2-basket-links";
import { BasketReadOnlyContext, OFFLINE_TITLE } from "./v2-basket-read-only";
import { purchaseTotalCents, type BasketComparison } from "./v2-basket-comparison";
import { basketQuantityLabel } from "./v2-basket-share-labels";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";
import { itemHref, itemKind, itemName, money, productName, storeName } from "./v2-basket-view";
import { splitList, storeChoices, storeList, withChecked, type ListLine, type ListSection, type ListView } from "./v2-shopping-list";
import "./v2-shared-basket.css";
import "./v2-shopping-list.css";

/** Where to look for an alternative to an article a store has no price for: its group, or the article itself. */
function alternativesHref(item: BasketItem): string {
  if (!("kind" in item) && item.data.group?.trim()) return "/v2/categories/" + encodeURIComponent(item.data.group.trim());
  return itemHref(item);
}

/** The product chosen for a group, its pack size and, with quantities, the need. */
function lineDetail(line: ListLine, advanced: boolean): string {
  const choice = line.choice;
  const product = choice ? productName(choice.product) : null;
  return [
    choice && "kind" in line.item && product ? product : null,
    choice?.product.data.quantity || null,
    advanced && line.item.quantity ? `besoin : ${basketQuantityLabel(line.item.quantity)}` : null,
  ].filter(Boolean).join(" · ");
}

function Line({ line, advanced, checked, onCheck }: { line: ListLine; advanced: boolean; checked: boolean; onCheck: (on: boolean) => void }) {
  const choice = line.choice;
  const detail = lineDetail(line, advanced);
  const linked = useContext(BasketLinksContext);
  return <li className="v2-list-line" data-checked={checked} data-missing={!choice}>
    <label>
      <input type="checkbox" checked={checked} onChange={event => onCheck(event.target.checked)} />
      <span className="v2-list-line-text"><strong>{choice && choice.packages > 1 ? `${choice.packages} × ` : ""}{itemName(line.item)}</strong>
        {detail && <small>{detail}</small>}</span>
      {choice && <span className="v2-list-line-price">{money(choice.cents)}</span>}
    </label>
    {!choice && <div className="v2-list-line-help">
      <span>Pas de prix ici : cherchez une alternative en rayon et relevez son prix.</span>
      {linked && <Link to={alternativesHref(line.item)}>Voir les alternatives et leurs prix</Link>}
      {linked && !("kind" in line.item) && <Link to={"/v2/produits/" + line.item.id}>Relever le prix de ce produit</Link>}
    </div>}
  </li>;
}

function Section({ section, advanced, checked, onCheck, missingTitle }: {
  section: ListSection; advanced: boolean; checked: Set<string>; onCheck: (key: string, on: boolean) => void; missingTitle: string;
}) {
  const choices = section.lines.flatMap(line => line.choice ? [line.choice] : []);
  const done = section.lines.filter(line => checked.has(line.key)).length;
  return <section className="v2-list-section" id={`magasin-${section.key}`} aria-label={`${section.reading.retailer} · ${storeName(section.reading)}`}>
    <header><div><h2>{section.reading.retailer}</h2><p>{storeName(section.reading)}</p></div>
      <div className="v2-list-section-total"><strong>{money(purchaseTotalCents(choices, advanced))}</strong><small>{done}/{section.lines.length} pris</small></div></header>
    {section.missing.length > 0 && <div className="v2-list-missing"><h3>{missingTitle}</h3>
      <ul>{section.missing.map(line => <Line key={line.key} line={line} advanced={advanced} checked={checked.has(line.key)} onCheck={on => onCheck(line.key, on)} />)}</ul></div>}
    <ul>{section.lines.map(line => <Line key={line.key} line={line} advanced={advanced} checked={checked.has(line.key)} onCheck={on => onCheck(line.key, on)} />)}</ul>
  </section>;
}

/** One article of the checklist: no price needed, only what to take. */
function Article({ item, advanced, checked, onCheck, addedBy }: {
  item: BasketItem; advanced: boolean; checked: boolean; onCheck: (on: boolean) => void; addedBy?: string | null;
}) {
  const detail = [
    "kind" in item ? itemKind(item) : item.data.quantity || null,
    advanced && item.quantity ? `besoin : ${basketQuantityLabel(item.quantity)}` : null,
    addedBy ? `ajouté par ${addedBy}` : null,
  ].filter(Boolean).join(" · ");
  return <li className="v2-list-line" data-checked={checked}>
    <label><input type="checkbox" checked={checked} onChange={event => onCheck(event.target.checked)} />
      <span className="v2-list-line-text"><strong>{itemName(item)}</strong>{detail && <small>{detail}</small>}</span></label>
  </li>;
}

/**
 * The list view of a basket, in one of three modes kept with the basket (shared live, so any member
 * of a shared basket switches it for everyone): all the included articles as a checklist, without
 * prices (it works offline); the cheapest split across stores; or the whole basket in one store,
 * its missing articles first. Store filters apply, and stores switched off are left out. Ticks are
 * kept in this browser, or with the shared basket for every member.
 */
export default function V2ShoppingList({ view, onView, items, comparison, split, storesOff, advanced, checked, onChecked, basePath, sharedName, addedBy, fetchHint }: {
  view: ListView; onView: (view: ListView) => void; items: BasketItem[];
  comparison: BasketComparison | null; split: BasketComparison | null; storesOff: string[];
  advanced: boolean; checked: string[]; onChecked: (keys: string[]) => void; basePath: string; sharedName?: string;
  addedBy?: (item: BasketItem) => string | null;
  /** Shown instead of the store modes when no prices were fetched for this basket. */
  fetchHint: string;
}) {
  const readOnly = useContext(BasketReadOnlyContext);
  const ticked = new Set(checked);
  const keys = items.map(basketItemKey);
  const check = (key: string, on: boolean) => onChecked(withChecked(checked, key, on, keys));
  const priced = comparison && split;
  const choices = comparison ? storeChoices(comparison.stores, storesOff) : [];
  const chosen = view.kind === "store" ? choices.find(store => store.key === view.key) ?? null : null;
  const one = chosen && priced ? storeList(comparison, items, chosen.key, basketItemKey) : null;
  const whole = view.kind === "stores" && priced ? splitList(split, items, basketItemKey) : null;
  const done = items.filter(item => ticked.has(basketItemKey(item))).length;
  const mode = (kind: ListView["kind"]) => {
    if (kind === "store") { const first = chosen ?? choices[0]; if (first) onView({ kind: "store", key: first.key }); }
    else onView({ kind } as ListView);
  };
  return <div className="v2-shopping-list">
    <div className="v2-list-toolbar">
      <Link className="v2-button v2-button-secondary" to={basePath}>← {sharedName ? "Panier partagé" : "Panier"}</Link>
      <button type="button" className="v2-button v2-button-secondary" disabled={!checked.length} onClick={() => onChecked([])}>Tout décocher</button>
    </div>
    {readOnly && !sharedName && <p className="v2-basket-offline-note" role="status">Hors connexion : vous pouvez cocher les articles ; le mode de la liste change au retour de la connexion.</p>}
    <fieldset className="v2-list-modes" disabled={readOnly} title={readOnly ? OFFLINE_TITLE : undefined}>
      <legend>Liste{sharedName ? " (la même pour tous les membres)" : ""}</legend>
      <label><input type="radio" name="v2-list-mode" checked={view.kind === "all"} onChange={() => mode("all")} />Tous les articles</label>
      <label><input type="radio" name="v2-list-mode" checked={view.kind === "stores"} onChange={() => mode("stores")} />Répartie entre les magasins</label>
      <label><input type="radio" name="v2-list-mode" checked={view.kind === "store"} disabled={!choices.length} onChange={() => mode("store")} />Tout dans un magasin</label>
      {view.kind === "store" && choices.length > 0 && <label className="v2-list-store-choice">Magasin
        <select value={chosen?.key ?? ""} onChange={event => onView({ kind: "store", key: event.target.value })}>
          {!chosen && <option value="">Choisir un magasin</option>}
          {choices.map(store => <option key={store.key} value={store.key}>{store.reading.retailer} · {storeName(store.reading)} · {money(store.cents)} · {store.coverage}/{items.length}</option>)}
        </select></label>}
    </fieldset>
    {sharedName && <p className="v2-list-note">Liste de « {sharedName} » : le mode et les articles cochés sont les mêmes pour tous ses membres, en direct.</p>}
    {view.kind === "all" && (items.length ? <section className="v2-list-section" aria-label="Tous les articles">
      <header><div><h2>Tous les articles</h2><p>Les articles inclus du panier, sans prix : cochez-les en rayon.</p></div>
        <div className="v2-list-section-total"><strong>{done}/{items.length}</strong><small>pris</small></div></header>
      <ul>{items.map(item => <Article key={basketItemKey(item)} item={item} advanced={advanced} checked={ticked.has(basketItemKey(item))}
        onCheck={on => check(basketItemKey(item), on)} addedBy={addedBy?.(item)} />)}</ul>
    </section> : <p>Rien à acheter : ajoutez ou incluez des articles dans le panier.</p>)}
    {view.kind !== "all" && !priced && <div className="v2-recipes-card"><p>{fetchHint}</p><Link to={basePath}>Comparer les prix du panier</Link></div>}
    {view.kind === "store" && priced && !chosen && <p role="alert">{choices.length
      ? "Ce magasin n’est plus proposé (filtres du panier, magasin désactivé ou prix actualisés) : choisissez-en un autre."
      : "Aucun magasin ne correspond aux filtres du panier, hors magasins désactivés."}</p>}
    {one && <Section section={one} advanced={advanced} checked={ticked} onCheck={check} missingTitle="Pas de prix dans ce magasin" />}
    {whole && <>
      {whole.unpriced.length > 0 && <section className="v2-list-section v2-list-missing" aria-label="Sans prix"><h2>Sans prix dans les magasins comparés</h2>
        <p>À chercher sur place : repérez une alternative et relevez son prix.</p>
        <ul>{whole.unpriced.map(line => <Line key={line.key} line={line} advanced={advanced} checked={ticked.has(line.key)} onCheck={on => check(line.key, on)} />)}</ul></section>}
      {whole.sections.map(section => <Section key={section.key} section={section} advanced={advanced} checked={ticked} onCheck={check} missingTitle="Pas de prix ici" />)}
      {!whole.sections.length && !whole.unpriced.length && <p>Rien à acheter : activez des articles du panier.</p>}
    </>}
  </div>;
}
