import { Link } from "react-router-dom";
import { purchaseTotalCents, type BasketComparison } from "./v2-basket-comparison";
import { basketQuantityLabel } from "./v2-basket-share-labels";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";
import { itemHref, itemName, money, productName, storeName } from "./v2-basket-view";
import { splitList, splitStoreList, storeList, withChecked, type ListLine, type ListSection } from "./v2-shopping-list";
import "./v2-shopping-list.css";

/** Where to look for an alternative to an article a store has no price for: its group, or the article itself. */
function alternativesHref(item: BasketItem): string {
  if (!("kind" in item) && item.data.group?.trim()) return "/v2/categories/" + encodeURIComponent(item.data.group.trim());
  return itemHref(item);
}

function Line({ line, advanced, checked, onCheck }: { line: ListLine; advanced: boolean; checked: boolean; onCheck: (on: boolean) => void }) {
  const choice = line.choice;
  const product = choice ? productName(choice.product) : null;
  const detail = [
    choice && "kind" in line.item && product ? product : null,
    choice?.product.data.quantity || null,
    advanced && line.item.quantity ? `besoin : ${basketQuantityLabel(line.item.quantity)}` : null,
  ].filter(Boolean).join(" · ");
  return <li className="v2-list-line" data-checked={checked} data-missing={!choice}>
    <label>
      <input type="checkbox" checked={checked} onChange={event => onCheck(event.target.checked)} />
      <span className="v2-list-line-text"><strong>{choice && choice.packages > 1 ? `${choice.packages} × ` : ""}{itemName(line.item)}</strong>
        {detail && <small>{detail}</small>}</span>
      {choice && <span className="v2-list-line-price">{money(choice.cents)}</span>}
    </label>
    {!choice && <div className="v2-list-line-help">
      <span>Pas de prix ici : cherchez une alternative en rayon et relevez son prix.</span>
      <Link to={alternativesHref(line.item)}>Voir les alternatives et leurs prix</Link>
      {!("kind" in line.item) && <Link to={"/v2/produits/" + line.item.id}>Relever le prix de ce produit</Link>}
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

/**
 * The shopping list of a basket, from the prices already fetched. For one store (from its card):
 * the whole basket there, its missing articles first. Otherwise: the split, one section per store.
 * Ticks are kept in this browser, or with the shared basket for every member.
 */
export default function V2ShoppingList({ comparison, split, items, store, advanced, checked, onChecked, backTo, sharedName }: {
  comparison: BasketComparison; split: BasketComparison; items: BasketItem[]; store: { key: string; split: boolean } | null;
  advanced: boolean; checked: string[]; onChecked: (keys: string[]) => void; backTo: string; sharedName?: string;
}) {
  const ticked = new Set(checked);
  const keys = items.map(basketItemKey);
  const check = (key: string, on: boolean) => onChecked(withChecked(checked, key, on, keys));
  const one = store ? store.split ? splitStoreList(split, store.key, basketItemKey) : storeList(comparison, items, store.key, basketItemKey) : null;
  const whole = store ? null : splitList(split, items, basketItemKey);
  return <div className="v2-shopping-list">
    <div className="v2-list-toolbar">
      <Link className="v2-button v2-button-secondary" to={backTo}>← {sharedName ? "Panier partagé" : "Panier"}</Link>
      {store && <Link className="v2-button v2-button-secondary" to={backTo + "/liste"}>Liste complète, par magasin</Link>}
      <button type="button" className="v2-button v2-button-secondary" disabled={!checked.length} onClick={() => onChecked([])}>Tout décocher</button>
    </div>
    {sharedName && <p className="v2-list-note">Liste de « {sharedName} » : les articles cochés le sont pour tous ses membres, en direct.</p>}
    {store && !one && <p role="alert">Ce magasin n’est plus dans la comparaison de ce panier (filtres, magasin désactivé ou prix actualisés).</p>}
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
