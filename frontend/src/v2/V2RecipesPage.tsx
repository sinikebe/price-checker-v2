import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import V2ReportControl from "./V2ReportControl";
import { positiveDecimal, scaledQuantity } from "../recipes/quantity";
import type { V2User } from "./v2-auth-api";
import { productRequest, type Product } from "./v2-products-api";
import { recipeRequest, type Recipe, type RecipeIngredient, type RecipeInput, type RecipePage, type RecipeUnit } from "./v2-recipes-api";
import "./v2-recipes.css";
import { offlineRecipeSummaries, SYNC_EVENT } from "../pwa/data-sync";

type Mode = "list" | "detail" | "new" | "edit";
type Props = { mode: Mode; id?: number; user: V2User | null; onLogout: () => Promise<void> };
const units: RecipeUnit[] = ["g", "kg", "ml", "cl", "l", "piece"];
const blankIngredient = (): RecipeIngredient => ({ label: "", amount: null, unit: null, note: "", optional: false, product_id: null, group_name: "" });
const blankRecipe = (): RecipeInput => ({ title: "", description: "", base_servings: "2", prep_minutes: null, cook_minutes: null, steps: [""], ingredients: [blankIngredient()] });
const productName = (product: Product["data"]) => [product.brand, product.name, product.quantity].filter(Boolean).join(" · ");
const message = (error: unknown) => error instanceof Error ? error.message : "Une erreur est survenue.";

function Frame({ children, user, onLogout }: { children: ReactNode; user: V2User | null; onLogout: () => Promise<void> }) {
  return <div className="v2-home v2-recipes">
    <a className="v2-skip" href="#v2-recipes-main">Aller au contenu</a>
    <header className="v2-header"><div className="v2-wrap v2-header-inner">
      <Link className="v2-brand" to="/v2"><span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span><span>price<span className="v2-brand-accent">checker</span><span className="v2-brand-period">.</span></span></Link>
      <nav className="v2-nav" aria-label="Navigation principale">
        <Link to="/v2">Accueil</Link><Link to="/v2/produits">Produits</Link><Link className="v2-nav-current" to="/v2/recettes" aria-current="page">Recettes</Link><Link to="/v2/panier">Panier</Link><Link to="/v2/parametres">Paramètres</Link>
        {user ? <span className="v2-account-nav"><span>{user.username}</span><button type="button" onClick={() => { void onLogout(); }}>Déconnexion</button></span> : <Link to="/v2/connexion">Connexion</Link>}
      </nav>
    </div></header>
    <main id="v2-recipes-main" className="v2-wrap v2-recipes-main">{children}</main>
  </div>;
}

function List({ user, onLogout }: Props) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<RecipePage | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { const updated = () => setRefresh(value => value + 1); window.addEventListener(SYNC_EVENT, updated); return () => window.removeEventListener(SYNC_EVENT, updated); }, []);
  useEffect(() => {
    let active = true;
    recipeRequest<RecipePage>(`?q=${encodeURIComponent(q)}&page=${page}`)
      .then(value => { if (active) { setResult(value); setError(""); } })
      .catch(reason => { if (active) { const all = offlineRecipeSummaries().filter(item => item.title.toLocaleLowerCase().includes(q.toLocaleLowerCase())); if (all.length || localStorage.getItem("v2:pwa:recipe-summaries-ready") === "1") setResult({ items: all.slice((page - 1) * 20, page * 20), total: all.length, page, page_size: 20 }); else setError(message(reason)); } });
    return () => { active = false; };
  }, [q, page, refresh]);
  return <Frame user={user} onLogout={onLogout}>
    <div className="v2-recipes-heading"><div><span className="v2-section-kicker">À CUISINER</span><h1>Recettes<span>.</span></h1><p>Des ingrédients précis quand vous le souhaitez, ou un groupe pour garder le choix.</p></div>
      <Link className="v2-button v2-button-primary" to="/v2/recettes/nouvelle">Ajouter une recette →</Link></div>
    <label className="v2-recipes-search">Rechercher une recette<input type="search" value={q} onChange={event => { setQ(event.target.value); setPage(1); }} placeholder="Nom de la recette" /></label>
    {error && <p role="alert" className="v2-recipes-error">{error}</p>}
    {!result && !error && <p>Chargement…</p>}
    {result && <><div className="v2-recipes-list">{result.items.map(recipe => <Link key={recipe.id} to={`/v2/recettes/${recipe.id}`} className="v2-recipes-tile"><strong>{recipe.title}</strong><span>{recipe.base_servings} portions · {recipe.ingredient_count} ingrédients</span>{recipe.description && <p>{recipe.description}</p>}</Link>)}</div>
      {!result.items.length && <p className="v2-recipes-empty">Aucune recette pour le moment.</p>}
      {result.total > result.page_size && <div className="v2-recipes-pager"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédent</button><span>Page {page} / {Math.ceil(result.total / result.page_size)}</span><button disabled={page * result.page_size >= result.total} onClick={() => setPage(page + 1)}>Suivant</button></div>}
    </>}
  </Frame>;
}

function Detail({ id, user, onLogout }: Props) {
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsError, setProductsError] = useState(false);
  const [error, setError] = useState("");
  const [servings, setServings] = useState("");
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    recipeRequest<Recipe>(`/${id}`).then(value => { if (active) { setRecipe(value); setServings(value.base_servings); } }).catch(reason => { if (active) setError(message(reason)); });
    productRequest<Product[]>("").then(value => { if (active) { setProducts(value); setProductsError(false); } }).catch(() => { if (active) setProductsError(true); });
    return () => { active = false; };
  }, [id]);
  async function remove() {
    if (!recipe || !window.confirm(`Supprimer « ${recipe.title} » ?`)) return;
    setDeleting(true);
    try { await recipeRequest<void>(`/${recipe.id}`, "DELETE"); navigate("/v2/recettes"); }
    catch (reason) { setError(message(reason)); setDeleting(false); }
  }
  return <Frame user={user} onLogout={onLogout}>
    <Link className="v2-recipes-back" to="/v2/recettes">← Toutes les recettes</Link>
    {error && <p role="alert" className="v2-recipes-error">{error}</p>}
    {!recipe && !error && <p>Chargement…</p>}
    {recipe && <><div className="v2-recipes-heading"><div><span className="v2-section-kicker">RECETTE · {recipe.author}</span><h1>{recipe.title}<span>.</span></h1><p>{recipe.description}</p></div>
      {(user?.id === recipe.author_id || user?.role === "admin") && <div className="v2-recipes-actions"><Link className="v2-button v2-button-secondary" to={`/v2/recettes/${recipe.id}/modifier`}>Modifier</Link><button className="v2-button v2-button-secondary" disabled={deleting} onClick={() => { void remove(); }}>Supprimer</button></div>}</div>
      <div className="v2-recipes-detail-grid"><section className="v2-recipes-card"><h2>Ingrédients</h2>
        <label className="v2-recipes-servings">Pour <input aria-label="Nombre de portions" type="number" min="0.001" step="0.001" value={servings} onChange={event => setServings(event.target.value)} /> portions</label>
        <ul className="v2-recipes-ingredients">{recipe.ingredients.map(item => {
          const choices = item.group_name ? products.filter(product => product.data.group.trim().toLocaleLowerCase() === item.group_name?.trim().toLocaleLowerCase()) : [];
          return <li key={item.id}><div><strong>{item.amount && positiveDecimal(servings) ? `${scaledQuantity(item.amount, servings, recipe.base_servings)} ${item.unit === "piece" ? "pièce(s)" : item.unit} · ` : ""}{item.label}</strong>{item.optional && <span>Facultatif</span>}</div>
            {item.product_id && <p>Produit précis : <Link to={`/v2/produits/${item.product_id}`}>{item.product ? productName(item.product) : `Produit #${item.product_id}`}</Link></p>}
            {item.group_name && <div><p>Au choix dans « {item.group_name} »</p>{choices.length ? <div className="v2-recipes-choices">{choices.map(product => <Link key={product.id} to={`/v2/produits/${product.id}`}>{productName(product.data)} →</Link>)}</div> : <small>{productsError ? "Choix indisponibles actuellement." : "Aucun produit publié dans ce groupe pour le moment."}</small>}</div>}
            {item.note && <small>{item.note}</small>}
          </li>;
        })}</ul></section>
        <section className="v2-recipes-card"><h2>Préparation</h2><p className="v2-recipes-meta">{recipe.prep_minutes != null && `Préparation : ${recipe.prep_minutes} min · `}{recipe.cook_minutes != null && `Cuisson : ${recipe.cook_minutes} min`}</p><ol className="v2-recipes-steps">{recipe.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></section></div>
      <V2ReportControl kind="recipe" contentId={recipe.id} user={user} />
    </>}
  </Frame>;
}

function move<T>(items: T[], index: number, offset: number): T[] {
  const next = [...items];
  const target = index + offset;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function localRead(key: string): { form: RecipeInput; revision: number | null } | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function Editor({ mode, id, user, onLogout }: Props) {
  const key = mode === "new" ? `v2:recipe:new${user ? ":" + user.id : ""}` : `v2:recipe:edit:${user?.id ?? "anon"}:${id}`;
  const [local] = useState(() => localRead(key));
  const [form, setForm] = useState<RecipeInput>(() => local?.form ?? blankRecipe());
  const [revision, setRevision] = useState<number | null>(() => local?.revision ?? null);
  const [savedRecipe, setSavedRecipe] = useState<Recipe | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsError, setProductsError] = useState(false);
  const [loading, setLoading] = useState(mode === "edit");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(Boolean(local));
  const [storageError, setStorageError] = useState("");
  const generation = useRef(0);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    if (mode === "edit") recipeRequest<Recipe>(`/${id}`).then(value => {
      if (!active) return;
      setSavedRecipe(value);
      if (!local) { setForm({ title: value.title, description: value.description, base_servings: value.base_servings, prep_minutes: value.prep_minutes, cook_minutes: value.cook_minutes, steps: value.steps, ingredients: value.ingredients }); setRevision(value.revision); }
      setLoading(false);
    }).catch(reason => { if (active) { setError(message(reason)); setLoading(false); } });
    productRequest<Product[]>("").then(value => { if (active) { setProducts(value); setProductsError(false); } }).catch(() => { if (active) setProductsError(true); });
    return () => { active = false; };
  }, [mode, id, local]);
  function change(next: RecipeInput) {
    setForm(next); setDirty(true); generation.current += 1;
    try { localStorage.setItem(key, JSON.stringify({ form: next, revision })); setStorageError(""); }
    catch { setStorageError("Stockage local indisponible : copiez votre recette avant de quitter la page."); }
  }
  function ingredient(index: number, patch: Partial<RecipeIngredient>) { change({ ...form, ingredients: form.ingredients.map((item, position) => position === index ? { ...item, ...patch } : item) }); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!user) { setError("Connectez-vous pour enregistrer cette recette. Votre saisie reste dans ce navigateur."); return; }
    if (!form.title.trim() || !positiveDecimal(form.base_servings) || form.steps.some(step => !step.trim()) || form.ingredients.some(item => !item.label.trim() || (!!item.amount !== !!item.unit) || (item.amount !== null && !positiveDecimal(item.amount)) || (item.product_id === null && !item.group_name?.trim()))) {
      setError("Complétez le titre, les portions, les étapes et chaque ingrédient (produit ou groupe, quantité et unité ensemble)."); return;
    }
    setBusy(true); setError("");
    const snapshot = generation.current;
    try {
      const payload = { ...form, title: form.title.trim(), steps: form.steps.map(step => step.trim()), ingredients: form.ingredients.map(item => ({ ...item, label: item.label.trim(), group_name: item.product_id ? null : item.group_name?.trim() || null })) };
      const saved = await recipeRequest<Recipe>(mode === "new" ? "" : `/${id}`, mode === "new" ? "POST" : "PUT", mode === "new" ? payload : { ...payload, revision });
      if (snapshot === generation.current) localStorage.removeItem(key);
      navigate(`/v2/recettes/${saved.id}`);
    } catch (reason) { setError(message(reason)); setBusy(false); }
  }
  const cancelTo = savedRecipe ? `/v2/recettes/${savedRecipe.id}` : "/v2/recettes";
  const groups = [...new Set(products.map(product => product.data.group.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  return <Frame user={user} onLogout={onLogout}>
    <Link className="v2-recipes-back" to={cancelTo}>← Recettes</Link>
    <div className="v2-recipes-heading"><div><span className="v2-section-kicker">ATELIER RECETTE</span><h1>{mode === "new" ? "Nouvelle recette" : "Modifier la recette"}<span>.</span></h1><p>Un ingrédient peut viser une référence précise ou laisser le choix dans un groupe. La recette, ses étapes et ses notes seront publiques : évitez les informations personnelles.</p></div></div>
    {loading && <p>Chargement…</p>}
    {error && <p role="alert" className="v2-recipes-error">{error}</p>}
    {storageError && <p role="alert" className="v2-recipes-error">{storageError}</p>}
    {(mode === "new" || savedRecipe || local) && <form className="v2-recipes-form" onSubmit={save}><fieldset disabled={busy || (mode === "edit" && loading)}>
      <section className="v2-recipes-card"><h2>La recette</h2><div className="v2-recipes-fields"><label>Titre<input required maxLength={200} value={form.title} onChange={event => change({ ...form, title: event.target.value })} /></label><label>Description<textarea value={form.description} onChange={event => change({ ...form, description: event.target.value })} /></label><label>Portions<input required type="number" min="0.001" step="0.001" value={form.base_servings} onChange={event => change({ ...form, base_servings: event.target.value })} /></label><label>Préparation (min)<input type="number" min="0" value={form.prep_minutes ?? ""} onChange={event => change({ ...form, prep_minutes: event.target.value ? Number(event.target.value) : null })} /></label><label>Cuisson (min)<input type="number" min="0" value={form.cook_minutes ?? ""} onChange={event => change({ ...form, cook_minutes: event.target.value ? Number(event.target.value) : null })} /></label></div></section>
      <section className="v2-recipes-card"><h2>Ingrédients</h2>{productsError && <p className="v2-recipes-error">Catalogue indisponible : vous pouvez saisir un groupe, mais le choix d’un produit précis attendra son retour.</p>}{form.ingredients.map((item, index) => <div className="v2-recipes-ingredient-edit" key={index}><div className="v2-recipes-row"><strong>Ingrédient {index + 1}</strong><div><button type="button" aria-label={`Monter ingrédient ${index + 1}`} disabled={index === 0} onClick={() => change({ ...form, ingredients: move(form.ingredients, index, -1) })}>↑</button><button type="button" aria-label={`Descendre ingrédient ${index + 1}`} disabled={index === form.ingredients.length - 1} onClick={() => change({ ...form, ingredients: move(form.ingredients, index, 1) })}>↓</button><button type="button" disabled={form.ingredients.length === 1} onClick={() => change({ ...form, ingredients: form.ingredients.filter((_, position) => position !== index) })}>Retirer</button></div></div>
        <div className="v2-recipes-fields"><label>Nom dans la recette<input required value={item.label} placeholder="Mayonnaise" onChange={event => ingredient(index, { label: event.target.value })} /></label>
          <label>Choix<select value={item.product_id ? "product" : "group"} onChange={event => ingredient(index, event.target.value === "product" ? { product_id: products[0]?.id ?? null, group_name: null } : { product_id: null, group_name: "" })}><option value="group">Groupe de produits</option><option value="product" disabled={products.length === 0}>Produit précis</option></select></label>
          {item.product_id ? <label>Produit<select value={item.product_id} onChange={event => ingredient(index, { product_id: Number(event.target.value) })}>{!products.some(product => product.id === item.product_id) && item.product && <option value={item.product_id}>{productName(item.product)}</option>}{products.map(product => <option key={product.id} value={product.id}>{productName(product.data)}</option>)}</select></label> : <label>Groupe<input required list={`v2-recipe-groups-${index}`} value={item.group_name ?? ""} placeholder="Ex. Mayonnaise" onChange={event => ingredient(index, { group_name: event.target.value })} /><datalist id={`v2-recipe-groups-${index}`}>{groups.map(group => <option key={group} value={group} />)}</datalist></label>}
          <label>Quantité<input type="number" min="0.001" step="0.001" value={item.amount ?? ""} onChange={event => ingredient(index, { amount: event.target.value || null })} /></label><label>Unité<select value={item.unit ?? ""} onChange={event => ingredient(index, { unit: event.target.value as RecipeUnit || null })}><option value="">À préciser</option>{units.map(unit => <option key={unit} value={unit}>{unit === "piece" ? "pièce(s)" : unit}</option>)}</select></label><label>Note<input value={item.note} onChange={event => ingredient(index, { note: event.target.value })} /></label><label className="v2-recipes-check"><input type="checkbox" checked={item.optional} onChange={event => ingredient(index, { optional: event.target.checked })} />Facultatif</label></div></div>)}
        <button type="button" className="v2-button v2-button-secondary" onClick={() => change({ ...form, ingredients: [...form.ingredients, blankIngredient()] })}>+ Ajouter un ingrédient</button></section>
      <section className="v2-recipes-card"><h2>Étapes</h2>{form.steps.map((step, index) => <div className="v2-recipes-step-edit" key={index}><label>Étape {index + 1}<textarea required value={step} onChange={event => change({ ...form, steps: form.steps.map((current, position) => position === index ? event.target.value : current) })} /></label><div><button type="button" aria-label={`Monter étape ${index + 1}`} disabled={index === 0} onClick={() => change({ ...form, steps: move(form.steps, index, -1) })}>↑</button><button type="button" aria-label={`Descendre étape ${index + 1}`} disabled={index === form.steps.length - 1} onClick={() => change({ ...form, steps: move(form.steps, index, 1) })}>↓</button><button type="button" disabled={form.steps.length === 1} onClick={() => change({ ...form, steps: form.steps.filter((_, position) => position !== index) })}>Retirer</button></div></div>)}<button type="button" className="v2-button v2-button-secondary" onClick={() => change({ ...form, steps: [...form.steps, ""] })}>+ Ajouter une étape</button></section>
      <div className="v2-recipes-actions"><button type="submit" className="v2-button v2-button-primary">{busy ? "Enregistrement…" : "Enregistrer la recette"}</button><Link className="v2-button v2-button-secondary" to={cancelTo} onClick={event => { if (busy || (dirty && !window.confirm("Abandonner les modifications non enregistrées ?"))) event.preventDefault(); }}>Annuler</Link></div>
    </fieldset></form>}
  </Frame>;
}

export default function V2RecipesPage(props: Props) {
  if (props.mode === "list") return <List {...props} />;
  if (props.mode === "detail") return <Detail key={props.id} {...props} />;
  return <Editor key={`${props.mode}:${props.id}:${props.user?.id ?? "anon"}`} {...props} />;
}
