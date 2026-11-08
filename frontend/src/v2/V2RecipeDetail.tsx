import { useEffect, useMemo, useState } from "react";
import V2Info from "./V2Info";
import { Link, useNavigate } from "react-router-dom";
import { useConfirm } from "./useConfirm";
import { V2PageFrame } from "./V2SiteHeader";
import V2ReportControl from "./V2ReportControl";
import { plainDecimal, positiveDecimal, scaledQuantity } from "../recipes/quantity";
import { recipeBasketEntries } from "../recipes/basket";
import { productRequest, type Product } from "./v2-products-api";
import { currentBasketProduct } from "./v2-basket-product";
import { recipeRequest, type Recipe, type RecipeProposal } from "./v2-recipes-api";
import { message, PRIVATE_NOTE, privatePath, productName, unitLabel, type Props } from "./v2-recipes-format";
import { useAppMode } from "./useAppMode";
import { useV2Basket } from "./V2BasketContext";
import { useOnline } from "./useOnline";
import { enableAdvancedBasket } from "./useBasketView";
import { OFFLINE_TITLE } from "./v2-basket-read-only";
import { SHARED_BASKET_PATH } from "./v2-shared-basket";
import "./v2-recipes.css";

export default function V2RecipeDetail({ id, privateRecipe = false, user, onLogout }: Props) {
  const confirm = useConfirm();
  const basket = useV2Basket();
  // Shopping fills the basket from a recipe; the contribution mode edits, publishes and reports it.
  const contributing = useAppMode().mode === "contribute";
  // Offline, the baskets are read only: the ingredients are added once the connection is back.
  const online = useOnline();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [access, setAccess] = useState<{ recipeId: number; userId: number; canEdit: boolean } | null>(null);
  const userId = user?.id;
  // A private recipe is only ever returned to its author.
  const canEdit = privateRecipe ? recipe?.id === id : access !== null && access.recipeId === id && access.userId === userId && access.canEdit;
  const [reload, setReload] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState(() => new URLSearchParams(window.location.search).has("enregistree") ? "Recette enregistrée." : "");
  const [products, setProducts] = useState<Product[]>([]);
  const [productsError, setProductsError] = useState(false);
  const [productsLoadedFor, setProductsLoadedFor] = useState<number | null>(null);
  const [resolution, setResolution] = useState<{ recipeId: number; products: Record<number, Product> } | null>(null);
  const [error, setError] = useState("");
  const [servings, setServings] = useState("");
  const [selectedProducts, setSelectedProducts] = useState<Record<number, number>>({});
  const [included, setIncluded] = useState<Record<number, boolean>>({});
  const [basketError, setBasketError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    if (privateRecipe && !userId) return;
    recipeRequest<Recipe>(privateRecipe ? `/private/${id}` : `/${id}`).then(value => { if (active) { setRecipe(value); setServings(current => reload && current ? current : plainDecimal(value.base_servings)); setError(""); } })
      .catch(async reason => {
        if (!active) return;
        // Once its publication is approved, a private recipe lives at its public address.
        if (privateRecipe) {
          const published = await recipeRequest<Recipe>(`/${id}`).catch(() => null);
          if (!active) return;
          if (published) { navigate(`/v2/recettes/${id}`, { replace: true }); return; }
        }
        setError(message(reason));
      });
    return () => { active = false; };
  }, [id, privateRecipe, userId, reload, navigate]);
  useEffect(() => {
    let active = true;
    productRequest<Product[]>("").then(value => { if (active) { setProducts(value); setProductsError(false); setProductsLoadedFor(id ?? null); } })
      .catch(() => { if (active) { setProducts([]); setProductsError(true); setProductsLoadedFor(id ?? null); } });
    return () => { active = false; };
  }, [id]);
  const currentRecipe = recipe?.id === id ? recipe : null;
  const productsReady = productsLoadedFor === id;
  const missingProductIds = useMemo(() => currentRecipe && productsReady && !productsError
    ? [...new Set(currentRecipe.ingredients.map(item => item.product_id).filter((value): value is number => value !== null))]
      .filter(productId => !products.some(product => product.id === productId)) : [], [currentRecipe, products, productsReady, productsError]);
  const resolvedProducts = resolution && resolution.recipeId === id ? resolution.products : {};
  const resolvingProducts = missingProductIds.length > 0 && resolution?.recipeId !== id;
  // The products of each group, in catalogue order: read for every group ingredient on each render.
  const byGroup = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const product of products) {
      const key = product.data.group.trim().toLocaleLowerCase();
      const list = map.get(key);
      if (list) list.push(product);
      else map.set(key, [product]);
    }
    return map;
  }, [products]);
  useEffect(() => {
    if (!currentRecipe || !productsReady || productsError || !missingProductIds.length) return;
    let active = true;
    Promise.all(missingProductIds.map(async productId => [productId,
      await currentBasketProduct(productId, products, candidateId => productRequest<Product>("/" + candidateId))] as const))
      .then(entries => {
        if (!active) return;
        const resolved: Record<number, Product> = {};
        for (const [productId, product] of entries) if (product) resolved[productId] = product;
        setResolution({ recipeId: currentRecipe.id, products: resolved });
      });
    return () => { active = false; };
  }, [currentRecipe, products, productsReady, productsError, missingProductIds]);
  useEffect(() => {
    let active = true;
    if (userId && id !== undefined && !privateRecipe) {
      const recipeId = id;
      recipeRequest<{ can_edit: boolean }>("/" + recipeId + "/access")
        .then(value => { if (active) setAccess({ recipeId, userId, canEdit: value.can_edit }); })
        .catch(() => { if (active) setAccess({ recipeId, userId, canEdit: false }); });
    }
    return () => { active = false; };
  }, [id, userId, privateRecipe]);
  async function remove() {
    if (!currentRecipe || !await confirm({ title: "Supprimer la recette", message: `Supprimer « ${currentRecipe.title} » ? Cette suppression est définitive.`, confirmLabel: "Supprimer", danger: true })) return;
    setDeleting(true);
    try { await recipeRequest<void>(privateRecipe ? `/private/${currentRecipe.id}` : `/${currentRecipe.id}`, "DELETE"); navigate("/v2/recettes"); }
    catch (reason) { setError(message(reason)); setDeleting(false); }
  }
  async function publish() {
    if (!currentRecipe || !await confirm({ title: "Proposer à la publication", message: `Proposer « ${currentRecipe.title} » à la publication ?\n\nUn administrateur la relira. Elle reste privée jusqu'à sa validation, puis devient visible par tous et vous rapporte des crédits de contribution.`, confirmLabel: "Proposer" })) return;
    setPublishing(true); setError(""); setNotice("");
    try {
      await recipeRequest<RecipeProposal>(`/private/${currentRecipe.id}/publish`, "POST", { revision: currentRecipe.revision });
      setNotice("Demande de publication envoyée. La recette reste privée jusqu'à sa validation.");
      setReload(value => value + 1);
    } catch (reason) { setError(message(reason)); }
    finally { setPublishing(false); }
  }
  async function withdrawPublication(submissionId: number) {
    if (!await confirm({ title: "Retirer la demande", message: "Retirer la demande de publication ? La recette reste privée.", confirmLabel: "Retirer la demande" })) return;
    setPublishing(true); setError(""); setNotice("");
    try { await recipeRequest<void>(`/submissions/${submissionId}`, "DELETE"); setNotice("Demande retirée. Vous pouvez de nouveau modifier la recette."); setReload(value => value + 1); }
    catch (reason) { setError(message(reason)); }
    finally { setPublishing(false); }
  }
  /** The ingredients go to the personal basket, or to the shared one when `toShared`. */
  function addIngredients(toShared = false) {
    const target = toShared ? basket.sharedBasket : basket;
    if (!target) return;
    if (!currentRecipe || !positiveDecimal(servings)) { setBasketError("Indiquez un nombre de portions valide."); return; }
    if (!productsReady || resolvingProducts) { setBasketError("Vérification des références en cours. Réessayez dans un instant."); return; }
    const outcome = recipeBasketEntries(currentRecipe, servings, { products, resolved: resolvedProducts, selected: selectedProducts, included });
    if ("error" in outcome) { setBasketError(outcome.error); return; }
    const result = target.addQuantities(outcome.entries);
    if (result.conflicts) { setBasketError(result.conflicts + " quantité(s) incompatibles avec le panier actuel. Aucun ingrédient ajouté."); return; }
    // Quantities matter: the basket opens in the quantities mode (for every member of a shared basket).
    if (result.added || result.merged) {
      if (toShared) basket.shared.setSettings({ advanced: true });
      else enableAdvancedBasket();
    }
    navigate(toShared ? SHARED_BASKET_PATH : "/v2/panier");
  }
  return <V2PageFrame section="recipes" user={user} onLogout={onLogout}>
    <Link className="v2-recipes-back" to="/v2/recettes">← Toutes les recettes</Link>
    {error && <p role="alert" className="v2-recipes-error">{error}</p>}
    {!currentRecipe && !error && (!privateRecipe || userId) && <p>Chargement…</p>}
    {privateRecipe && !userId && <p role="alert" className="v2-recipes-error">Connectez-vous pour ouvrir vos recettes privées.</p>}
    {notice && <p role="status" className="v2-recipes-card">{notice}</p>}
    {currentRecipe && <><div className="v2-recipes-heading"><div><span className="v2-section-kicker">{privateRecipe ? "RECETTE PRIVÉE" : "RECETTE"}</span><h1>{currentRecipe.title}<span>.</span></h1><p>{currentRecipe.description}</p></div>
      {contributing && canEdit && <div className="v2-recipes-actions">{privateRecipe && currentRecipe.publication?.status === "pending"
        ? <span className="v2-recipes-private-badge">Modification bloquée pendant la validation</span>
        : <Link className="v2-button v2-button-secondary" to={privateRecipe ? `${privatePath(currentRecipe.id)}/modifier` : `/v2/recettes/${currentRecipe.id}/modifier`}>Modifier</Link>}<button className="v2-button v2-button-secondary" disabled={deleting} onClick={() => { void remove(); }}>Supprimer</button></div>}</div>
      {contributing && privateRecipe && <section className="v2-recipes-card v2-recipes-private" aria-label="Visibilité de la recette">
        <p><strong>Privée.</strong> {PRIVATE_NOTE}</p>
        {currentRecipe.publication?.status === "pending" ? <>
          <p>Publication demandée : en attente de validation par un administrateur. Elle restera privée jusque-là.</p>
          <button type="button" className="v2-button v2-button-secondary" disabled={publishing} onClick={() => { void withdrawPublication(currentRecipe.publication!.submission_id); }}>Retirer la demande</button>
        </> : <>
          {currentRecipe.publication?.status === "rejected" && <p>Votre dernière demande de publication a été refusée. Vous pouvez modifier la recette puis la proposer de nouveau.</p>}
          <button type="button" className="v2-button v2-button-primary" disabled={publishing} onClick={() => { void publish(); }}>{publishing ? "Envoi…" : "Proposer à la publication"}</button>
          <V2Info>Pour la partager avec tout le monde, proposez-la à la publication : un administrateur la relit, puis elle devient publique et vous rapporte des crédits de contribution.</V2Info>
        </>}
      </section>}
      <div className="v2-recipes-detail-grid"><section className="v2-recipes-card"><h2>Ingrédients{!contributing && <V2Info>Ajoutez les ingrédients au panier pour comparer le coût des paquets et des quantités utilisées. Les ingrédients facultatifs sont décochés par défaut.</V2Info>}</h2>
        <label className="v2-recipes-servings">Pour <input aria-label="Nombre de portions" type="number" min="0.001" step="0.001" value={servings} onChange={event => setServings(event.target.value)} /> portions</label>
        {basketError && <p role="alert" className="v2-recipes-error">{basketError}</p>}
        <ul className="v2-recipes-ingredients">{currentRecipe.ingredients.map((item, index) => {
          const choices = item.group_name ? byGroup.get(item.group_name.trim().toLocaleLowerCase()) ?? [] : [];
          return <li key={item.id}><div><strong>{item.amount && positiveDecimal(servings) ? `${scaledQuantity(item.amount, servings, currentRecipe.base_servings)} ${unitLabel(item.unit)} · ` : ""}{item.label}</strong>{item.optional && <span>Facultatif</span>}</div>
            {item.product_id && <p>Produit précis : <Link to={`/v2/produits/${resolvedProducts[item.product_id]?.id ?? item.product_id}`}>{resolvedProducts[item.product_id] ? productName(resolvedProducts[item.product_id].data) : item.product ? productName(item.product) : `Produit #${item.product_id}`}</Link>{resolvedProducts[item.product_id] && <small>Référence remplacée</small>}</p>}
            {item.group_name && <div><p>Au choix dans « {item.group_name} »</p>{choices.length ? <details className="v2-recipes-choices-list"><summary>{choices.length > 1 ? `Voir les ${choices.length} produits du groupe` : "Voir le produit du groupe"}</summary>
              <div className="v2-recipes-choices">{choices.map(product => <Link key={product.id} to={`/v2/produits/${product.id}`}>{productName(product.data)} →</Link>)}</div></details> : <small>{productsError ? "Choix indisponibles actuellement." : "Aucun produit publié dans ce groupe pour le moment."}</small>}</div>}
            {!contributing && item.optional && <label className="v2-recipes-check"><input type="checkbox" checked={included[index] === true} onChange={event => setIncluded({ ...included, [index]: event.target.checked })} />Ajouter cet ingrédient facultatif</label>}
            {!contributing && item.group_name && <label className="v2-recipes-basket-choice">Référence pour le panier<select value={selectedProducts[index] ?? 0} onChange={event => setSelectedProducts({ ...selectedProducts, [index]: Number(event.target.value) })}>
              <option value={0}>Choix automatique dans le groupe</option>{choices.map(product => <option key={product.id} value={product.id}>{productName(product.data)}</option>)}
            </select></label>}
            {item.note && <small>{item.note}</small>}
          </li>;
        })}</ul>{!contributing && <div className="v2-recipes-actions"><button type="button" className="v2-button v2-button-primary" disabled={!online} title={online ? undefined : OFFLINE_TITLE} onClick={() => addIngredients()}>Ajouter les ingrédients au panier →</button>
          {basket.sharedBasket && <button type="button" className="v2-button v2-button-secondary" disabled={!online} title={online ? undefined : OFFLINE_TITLE} onClick={() => addIngredients(true)}>Au panier partagé →</button>}</div>}</section>
        <section className="v2-recipes-card"><h2>Préparation</h2><p className="v2-recipes-meta">{currentRecipe.prep_minutes != null && `Préparation : ${currentRecipe.prep_minutes} min · `}{currentRecipe.cook_minutes != null && `Cuisson : ${currentRecipe.cook_minutes} min`}</p><ol className="v2-recipes-steps">{currentRecipe.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></section></div>
      {contributing && !privateRecipe && <V2ReportControl kind="recipe" contentId={currentRecipe.id} user={user} />}
    </>}
  </V2PageFrame>;
}
