import type { V2User } from "./v2-auth-api";
import { CONNECTOR_PRICE_REFRESH_EVENT } from "./v2-connector-page-refresh";
import { useExtensionRefresh } from "./useExtensionRefresh";

/**
 * For an administrator whose browser has the extension: reads this product's Carrefour price now, in the
 * background, and refreshes the prices shown. No tab opens in front and nothing is clicked on carrefour.fr.
 */
export default function V2ExtensionPriceButton({ productId, ean, user }: { productId: number; ean: string; user: V2User | null }) {
  const extension = useExtensionRefresh(user);
  if (!extension.available || !/^\d{8,14}$/.test(ean)) return null;
  const { state } = extension;
  const reading = state.phase === "reading";
  const message = state.phase === "reading"
    ? state.needsHuman ? "Carrefour demande une vérification : terminez-la dans l’onglet carrefour.fr qui vient de s’ouvrir."
      : `Extension : lecture du prix à ${state.store}…`
    : state.phase === "idle" ? "" : state.message;
  return <section className="v2-extension-product" aria-label="Relevé du prix Carrefour par l’extension">
    <button type="button" className="v2-button v2-button-secondary" disabled={reading}
      onClick={() => { void extension.start([productId], () => { window.dispatchEvent(new Event(CONNECTOR_PRICE_REFRESH_EVENT)); }, { announce: true }); }}>
      Relever le prix à Carrefour</button>
    {message && <p role="status" aria-live="polite">{message}</p>}
  </section>;
}
