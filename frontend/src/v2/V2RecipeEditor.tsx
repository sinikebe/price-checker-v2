import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useConfirm } from "./useConfirm";
import { V2PageFrame } from "./V2SiteHeader";
import { plainDecimal, positiveDecimal } from "../recipes/quantity";
import { productRequest, type Product } from "./v2-products-api";
import { recipeRequest, type Recipe, type RecipeIngredient, type RecipeInput, type RecipeUnit, type RecipeProposal } from "./v2-recipes-api";
import { message, PRIVATE_NOTE, privatePath, productName, unitLabel, type Props } from "./v2-recipes-format";
import { forgetLocalCopy, readLocalCopy, saveLocalCopy } from "./v2-recipes-local";
import { rewardHint } from "./v2-basket-credits-api";
import { useCredits } from "./useCredits";
import "./v2-recipes.css";
import "./v2-price-gate.css";

const units: RecipeUnit[] = ["g", "kg", "ml", "cl", "l", "piece"];
const blankIngredient = (): RecipeIngredient => ({ label: "", amount: null, unit: null, note: "", optional: false, product_id: null, group_name: "" });
const blankRecipe = (): RecipeInput => ({ title: "", description: "", base_servings: "2", prep_minutes: null, cook_minutes: null, steps: [""], ingredients: [blankIngredient()] });

function move<T>(items: T[], index: number, offset: number): T[] {
  const next = [...items];
  const target = index + offset;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** How a line of the editor's lists is moved or removed; `count` is the length of its list. */
type LineControls = { index: number; count: number; onMove: (offset: number) => void; onRemove: () => void };

/** One ingredient of the editor. The length caps are the server's (backend/app/api/v2/recipes.py). */
function IngredientFields({ item, index, count, products, groups, onChange, onMove, onRemove }: LineControls & {
  item: RecipeIngredient; products: Product[]; groups: string[]; onChange: (patch: Partial<RecipeIngredient>) => void;
}) {
  return <div className="v2-recipes-ingredient-edit">
    <div className="v2-recipes-row"><strong>Ingrédient {index + 1}</strong><div>
      <button type="button" aria-label={`Monter ingrédient ${index + 1}`} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
      <button type="button" aria-label={`Descendre ingrédient ${index + 1}`} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
      <button type="button" disabled={count === 1} onClick={() => onRemove()}>Retirer</button>
    </div></div>
    <div className="v2-recipes-fields">
      <label>Nom dans la recette<input required maxLength={200} value={item.label} placeholder="Mayonnaise" onChange={event => onChange({ label: event.target.value })} /></label>
      <label>Choix<select value={item.product_id ? "product" : "group"} onChange={event => onChange(event.target.value === "product" ? { product_id: products[0]?.id ?? null, group_name: null } : { product_id: null, group_name: "" })}>
        <option value="group">Groupe de produits</option>
        <option value="product" disabled={products.length === 0}>Produit précis</option>
      </select></label>
      {item.product_id
        ? <label>Produit<select value={item.product_id} onChange={event => onChange({ product_id: Number(event.target.value) })}>
          {!products.some(product => product.id === item.product_id) && item.product && <option value={item.product_id}>{productName(item.product)}</option>}
          {products.map(product => <option key={product.id} value={product.id}>{productName(product.data)}</option>)}
        </select></label>
        : <label>Groupe<input required maxLength={100} list={`v2-recipe-groups-${index}`} value={item.group_name ?? ""} placeholder="Ex. Mayonnaise" onChange={event => onChange({ group_name: event.target.value })} />
          <datalist id={`v2-recipe-groups-${index}`}>{groups.map(group => <option key={group} value={group} />)}</datalist></label>}
      <label>Quantité<input type="number" min="0.001" step="0.001" value={item.amount ?? ""} onChange={event => onChange({ amount: event.target.value || null })} /></label>
      <label>Unité<select value={item.unit ?? ""} onChange={event => onChange({ unit: event.target.value as RecipeUnit || null })}>
        <option value="">À préciser</option>
        {units.map(unit => <option key={unit} value={unit}>{unitLabel(unit)}</option>)}
      </select></label>
      <label>Note<input maxLength={1000} value={item.note} onChange={event => onChange({ note: event.target.value })} /></label>
      <label className="v2-recipes-check"><input type="checkbox" checked={item.optional} onChange={event => onChange({ optional: event.target.checked })} />Facultatif</label>
    </div>
  </div>;
}

/** One step of the editor; the server refuses a step over 5,000 characters. */
function StepFields({ step, index, count, onChange, onMove, onRemove }: LineControls & { step: string; onChange: (text: string) => void }) {
  return <div className="v2-recipes-step-edit">
    <label>Étape {index + 1}<textarea required maxLength={5000} value={step} onChange={event => onChange(event.target.value)} /></label>
    <div>
      <button type="button" aria-label={`Monter étape ${index + 1}`} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
      <button type="button" aria-label={`Descendre étape ${index + 1}`} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
      <button type="button" disabled={count === 1} onClick={() => onRemove()}>Retirer</button>
    </div>
  </div>;
}

export default function V2RecipeEditor({ mode, id, privateRecipe = false, user, onLogout }: Props) {
  const confirm = useConfirm();
  const replay = mode === "new" ? new URLSearchParams(window.location.search).get("reprendre") : null;
  const userId = user?.id;
  const key = replay ? `v2:recipe:proposal:${userId ?? "anon"}:${replay}` : mode === "new" ? `v2:recipe:new${user ? ":" + user.id : ""}`
    : `v2:recipe:edit:${userId ?? "anon"}:${privateRecipe ? "private-" : ""}${id}`;
  const [local] = useState(() => readLocalCopy(key));
  // Only a new recipe chooses; an existing one keeps its visibility (publishing has its own button).
  const choosesVisibility = mode === "new" && !replay;
  const [isPrivate, setIsPrivate] = useState(() => mode === "edit" ? privateRecipe : choosesVisibility && local?.private === true);
  const [form, setForm] = useState<RecipeInput>(() => local?.form ?? blankRecipe());
  const [revision, setRevision] = useState<number | null>(() => local?.revision ?? null);
  const [savedRecipe, setSavedRecipe] = useState<Recipe | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsError, setProductsError] = useState(false);

  const [loading, setLoading] = useState(mode === "edit");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const credits = useCredits(userId ?? null);
  const [dirty, setDirty] = useState(Boolean(local));
  const [storageError, setStorageError] = useState("");
  const [conflict, setConflict] = useState("");
  const [replayLoaded, setReplayLoaded] = useState(!replay || !userId);
  const generation = useRef(0);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    if (mode === "edit") recipeRequest<Recipe>(privateRecipe ? `/private/${id}` : `/${id}`).then(value => {
      if (!active) return;
      setSavedRecipe(value);
      if (!local) { setForm({ title: value.title, description: value.description, base_servings: plainDecimal(value.base_servings), prep_minutes: value.prep_minutes, cook_minutes: value.cook_minutes, steps: value.steps, ingredients: value.ingredients }); setRevision(value.revision); }
      else if (local.revision !== value.revision) setConflict((privateRecipe ? "La recette a changé" : "La recette publiée a changé") + " depuis votre copie locale. Copiez votre saisie avant de charger la version serveur.");
      setLoading(false);
    }).catch(reason => { if (active) { setError(message(reason)); setLoading(false); } });
    productRequest<Product[]>("").then(value => { if (active) { setProducts(value); setProductsError(false); } }).catch(() => { if (active) setProductsError(true); });
    return () => { active = false; };
  }, [mode, id, local, privateRecipe]);
  useEffect(() => {
    let active = true;
    if (!replay) return;
    if (!userId) return;
    recipeRequest<{ payload: RecipeInput; revision: number; status: string; result_recipe_id: number | null }>(`/submissions/${replay}`)
      .then(value => {
        if (!active) return;
        if (value.status === "approved") {
          if (value.result_recipe_id) navigate(`/v2/recettes/${value.result_recipe_id}`, { replace: true });
          else setError("Cette proposition est déjà validée.");
        } else if (local) {
          if (local.revision !== value.revision) setConflict("Cette proposition a changé sur le serveur. Copiez votre saisie avant de charger la nouvelle version.");
        } else { setForm(value.payload); setRevision(value.revision); }
        setReplayLoaded(true);
      })
      .catch(reason => { if (active) { setError(message(reason)); setReplayLoaded(true); } });
    return () => { active = false; };
  }, [replay, userId, local, navigate]);
  // The groups already used in the catalogue, offered while typing a group name.
  const groups = useMemo(() => [...new Set(products.map(product => product.data.group.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr")), [products]);
  function change(next: RecipeInput, visibility = isPrivate) {
    setForm(next); setDirty(true); generation.current += 1;
    if (saveLocalCopy(key, { form: next, revision, ...(choosesVisibility ? { private: visibility } : {}) })) setStorageError("");
    else setStorageError("Stockage local indisponible : copiez votre recette avant de quitter la page.");
  }
  function choose(visibility: boolean) { setIsPrivate(visibility); change(form, visibility); }
  function ingredient(index: number, patch: Partial<RecipeIngredient>) { change({ ...form, ingredients: form.ingredients.map((item, position) => position === index ? { ...item, ...patch } : item) }); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (conflict) { setError(conflict); return; }
    if (replay && revision === null) { setError("Chargez la proposition avant de l'envoyer."); return; }
    if (!user) { setError("Connectez-vous pour enregistrer cette recette. Votre saisie reste dans ce navigateur."); return; }
    if (!form.title.trim() || !positiveDecimal(form.base_servings) || form.steps.some(step => !step.trim()) || form.ingredients.some(item => !item.label.trim() || (!!item.amount !== !!item.unit) || (item.amount !== null && !positiveDecimal(item.amount)) || (item.product_id === null && !item.group_name?.trim()))) {
      setError("Complétez le titre, les portions, les étapes et chaque ingrédient (produit ou groupe, quantité et unité ensemble)."); return;
    }
    setBusy(true); setError("");
    const snapshot = generation.current;
    try {
      const payload = { ...form, title: form.title.trim(), steps: form.steps.map(step => step.trim()), ingredients: form.ingredients.map(item => ({ ...item, label: item.label.trim(), group_name: item.product_id ? null : item.group_name?.trim() || null })) };
      if (isPrivate) {
        // Saved at once, no review: back to the recipe itself.
        const saved = await recipeRequest<Recipe>(mode === "edit" ? `/private/${id}` : "/private", mode === "edit" ? "PUT" : "POST", mode === "edit" ? { ...payload, revision } : payload);
        // A copy typed during the request is newer than the one saved: keep it.
        if (snapshot === generation.current) forgetLocalCopy(key);
        navigate(privatePath(saved.id) + "?enregistree=1");
        return;
      }
      await recipeRequest<RecipeProposal>(replay ? `/submissions/${replay}` : mode === "new" ? "" : `/${id}`, replay || mode === "edit" ? "PUT" : "POST", mode === "edit" || replay ? { ...payload, revision } : payload);
      if (snapshot === generation.current) forgetLocalCopy(key);
      navigate("/v2/recettes?proposition=envoyee");
    } catch (reason) { setError(message(reason)); setBusy(false); }
  }
  const cancelTo = savedRecipe ? privateRecipe ? privatePath(savedRecipe.id) : `/v2/recettes/${savedRecipe.id}` : "/v2/recettes";
  const hint = isPrivate ? null : rewardHint("recipe", credits);
  return <V2PageFrame section="recipes" user={user} onLogout={onLogout}>
    <Link className="v2-recipes-back" to={cancelTo}>← Recettes</Link>
    <div className="v2-recipes-heading"><div><span className="v2-section-kicker">ATELIER RECETTE</span><h1>{replay ? "Modifier une proposition" : mode === "new" ? "Nouvelle recette" : isPrivate ? "Modifier la recette privée" : "Modifier la recette"}<span>.</span></h1><p>Un ingrédient peut viser une référence précise ou laisser le choix dans un groupe. {isPrivate ? "Cette recette reste privée : vous seul la voyez." : "La recette, ses étapes et ses notes seront publiées après validation : évitez les informations personnelles."}</p></div></div>
    {(loading || !replayLoaded) && <p>Chargement…</p>}
    {error && <p role="alert" className="v2-recipes-error">{error}</p>}
    {replay && !userId && <p role="alert" className="v2-recipes-error">Connectez-vous pour reprendre cette proposition.</p>}
    {storageError && <p role="alert" className="v2-recipes-error">{storageError}</p>}
    {conflict && <div role="alert" className="v2-recipes-error"><p>{conflict}</p><button type="button" onClick={() => { forgetLocalCopy(key); window.location.reload(); }}>Charger la version serveur</button></div>}
    {(mode === "new" || savedRecipe || local) && replayLoaded && (!replay || userId) && <form className="v2-recipes-form" onSubmit={save}><fieldset disabled={busy || (mode === "edit" && loading)}>
      {choosesVisibility && <fieldset className="v2-recipes-card v2-recipes-visibility"><legend>Visibilité</legend>
        <label className="v2-recipes-check"><input type="radio" name="v2-recipe-visibility" checked={!isPrivate} onChange={() => choose(false)} /><span><strong>Publique</strong> · Visible par tous après validation par un administrateur. Rapporte des crédits de contribution.</span></label>
        <label className="v2-recipes-check"><input type="radio" name="v2-recipe-visibility" checked={isPrivate} onChange={() => choose(true)} /><span><strong>Privée</strong> · {PRIVATE_NOTE} Vous pourrez la proposer à la publication plus tard.</span></label>
      </fieldset>}
      <section className="v2-recipes-card"><h2>La recette</h2><div className="v2-recipes-fields">
        <label>Titre<input required maxLength={200} value={form.title} onChange={event => change({ ...form, title: event.target.value })} /></label>
        <label>Description<textarea maxLength={10000} value={form.description} onChange={event => change({ ...form, description: event.target.value })} /></label>
        <label>Portions<input required type="number" min="0.001" step="0.001" value={form.base_servings} onChange={event => change({ ...form, base_servings: event.target.value })} /></label>
        <label>Préparation (min)<input type="number" min="0" max={100000} value={form.prep_minutes ?? ""} onChange={event => change({ ...form, prep_minutes: event.target.value ? Number(event.target.value) : null })} /></label>
        <label>Cuisson (min)<input type="number" min="0" max={100000} value={form.cook_minutes ?? ""} onChange={event => change({ ...form, cook_minutes: event.target.value ? Number(event.target.value) : null })} /></label>
      </div></section>
      <section className="v2-recipes-card"><h2>Ingrédients</h2>
        {productsError && <p className="v2-recipes-error">Catalogue indisponible : vous pouvez saisir un groupe, mais le choix d’un produit précis attendra son retour.</p>}
        {form.ingredients.map((item, index) => <IngredientFields key={index} item={item} index={index} count={form.ingredients.length} products={products} groups={groups}
          onChange={patch => ingredient(index, patch)}
          onMove={offset => change({ ...form, ingredients: move(form.ingredients, index, offset) })}
          onRemove={() => change({ ...form, ingredients: form.ingredients.filter((_, position) => position !== index) })} />)}
        <button type="button" className="v2-button v2-button-secondary" onClick={() => change({ ...form, ingredients: [...form.ingredients, blankIngredient()] })}>+ Ajouter un ingrédient</button></section>
      <section className="v2-recipes-card"><h2>Étapes</h2>
        {form.steps.map((step, index) => <StepFields key={index} step={step} index={index} count={form.steps.length}
          onChange={text => change({ ...form, steps: form.steps.map((current, position) => position === index ? text : current) })}
          onMove={offset => change({ ...form, steps: move(form.steps, index, offset) })}
          onRemove={() => change({ ...form, steps: form.steps.filter((_, position) => position !== index) })} />)}
        <button type="button" className="v2-button v2-button-secondary" onClick={() => change({ ...form, steps: [...form.steps, ""] })}>+ Ajouter une étape</button></section>
      {hint && <p className="v2-reward-hint">{hint}</p>}
      <div className="v2-recipes-actions"><button type="submit" className="v2-button v2-button-primary">{busy ? "Enregistrement…" : isPrivate ? "Enregistrer la recette privée" : "Envoyer pour validation"}</button><Link className="v2-button v2-button-secondary" to={cancelTo} onClick={event => {
        if (busy) { event.preventDefault(); return; }
        if (!dirty) return;
        event.preventDefault();
        void confirm({ title: "Abandonner les modifications", message: "Abandonner les modifications non enregistrées ?", confirmLabel: "Abandonner", danger: true })
          .then(yes => { if (yes) navigate(cancelTo); });
      }}>Annuler</Link></div>
    </fieldset></form>}
  </V2PageFrame>;
}
