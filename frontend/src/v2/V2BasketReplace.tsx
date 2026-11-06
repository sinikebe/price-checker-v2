import { useEffect, useMemo, useState } from "react";
import { suggestRequest, RateLimitedError } from "./v2-catalogue-api";
import type { Product } from "./v2-products-api";
import { basketItemKey, type BasketItem, type BasketText } from "./v2-basket-storage";
import { productName, type Category } from "./v2-basket-view";

let categories: Promise<Category[]> | null = null;
/** The catalogue's groups, read once per page: groups and ensembles are found among them. */
function readCategories(): Promise<Category[]> {
  categories ??= fetch("/api/v2/catalogue/categories", { credentials: "same-origin" })
    .then(response => { if (!response.ok) throw new Error("Catalogue indisponible"); return response.json() as Promise<Category[]>; })
    .catch(error => { categories = null; throw error; });
  return categories;
}
const fold = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("fr");
const matches = (value: string, words: string[]) => { const text = fold(value); return words.every(word => text.includes(word)); };
type Found = { products: Product[]; total: number; complete: boolean } | null;

/**
 * Replace a free text line by a product, a group or an ensemble of the catalogue, found from the text
 * itself. The quantity and the "included" choice of the line are kept.
 */
export default function V2BasketReplace({ item, taken, onPick, onClose }: {
  item: BasketText; taken: ReadonlySet<string>; onPick: (next: BasketItem) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState(item.name);
  const [groups, setGroups] = useState<Category[] | null>(null);
  const [found, setFound] = useState<Found>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    readCategories().then(value => { if (active) setGroups(value); }).catch(() => { if (active) setError("Groupes et ensembles indisponibles pour le moment."); });
    return () => { active = false; };
  }, []);
  const words = useMemo(() => fold(query).split(/\s+/).filter(word => word.length > 1), [query]);
  const search = query.replace(/\s+/g, " ").trim();
  useEffect(() => {
    if (search.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      suggestRequest<Product>(search, { category: "", storeId: 0 }, controller.signal)
        .then(result => { setFound({ products: result.items, total: result.total, complete: result.complete }); setError(""); })
        .catch(reason => {
          if (controller.signal.aborted) return;
          setError(reason instanceof RateLimitedError ? `Trop de recherches : réessayez dans ${reason.retryAfter} s.` : "Recherche de produits indisponible.");
        });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search]);
  const groupResults = words.length ? (groups ?? []).filter(group => matches(group.name, words)).slice(0, 6) : [];
  const scopes = new Map<string, { name: string; department: string; family: string }>();
  for (const group of groups ?? []) {
    if (group.comparison_scope && words.length && matches(group.comparison_scope, words))
      scopes.set([group.department, group.family, group.comparison_scope].map(fold).join(":"), { name: group.comparison_scope, department: group.department, family: group.family });
  }
  const scopeResults = [...scopes.values()].slice(0, 4);
  const choice = (next: BasketItem, label: string, detail?: string) => {
    const already = taken.has(basketItemKey(next));
    return <li key={basketItemKey(next)}><button type="button" disabled={already} onClick={() => onPick(next)}>
      <b>{label}</b>{(detail || already) && <small>{already ? "Déjà dans le panier" : detail}</small>}</button></li>;
  };
  return <div className="v2-basket-replace" role="group" aria-label={`Remplacer « ${item.name} »`}>
    <label>Chercher dans le catalogue<input value={query} onChange={event => setQuery(event.target.value)} autoFocus /></label>
    {groupResults.length > 0 && <><h4>Groupes</h4><ul>{groupResults.map(group =>
      choice({ kind: "group", name: group.name }, group.name, "Tous les produits de ce groupe sont comparés"))}</ul></>}
    {scopeResults.length > 0 && <><h4>Ensembles</h4><ul>{scopeResults.map(scope =>
      choice({ kind: "scope", ...scope }, scope.name, `${scope.department} · ${scope.family}`))}</ul></>}
    {found && found.products.length > 0 && <><h4>Produits</h4><ul>{found.products.slice(0, 8).map(product =>
      choice({ id: product.id, revision: product.revision, data: product.data }, productName(product), product.data.quantity || undefined))}</ul></>}
    {found && !found.complete && <p className="v2-basket-replace-note">{found.total} produits correspondent : précisez la recherche pour les voir.</p>}
    {search.length >= 2 && groups && found?.complete && !groupResults.length && !scopeResults.length && !found.products.length &&
      <p className="v2-basket-replace-note">Rien au catalogue pour « {search} » : gardez le texte libre, ou proposez le produit depuis le catalogue.</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="v2-basket-remove" onClick={onClose}>Fermer</button>
  </div>;
}
