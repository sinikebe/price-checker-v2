import type { ReactNode } from "react";
import type { V2User } from "./v2-auth-api";
import { useAppMode } from "./useAppMode";
import { V2PageFrame } from "./V2SiteHeader";

/**
 * Baskets and their lists belong to the shopping mode. Opened in the contribution mode (from a bookmark or a
 * shared link), the page offers to switch back instead of mixing both.
 */
export default function V2ShoppingOnly({ user, onLogout, children }: { user: V2User | null; onLogout: () => Promise<void>; children: ReactNode }) {
  const { mode, setMode } = useAppMode();
  if (mode !== "contribute") return <>{children}</>;
  return <V2PageFrame user={user} onLogout={onLogout}>
    <section className="v2-workspace-card v2-mode-notice" aria-labelledby="v2-mode-notice-title">
      <span className="v2-section-kicker">MODE CONTRIBUTION</span>
      <h1 id="v2-mode-notice-title">Paniers et listes<span>.</span></h1>
      <p>Le mode contribution sert à enrichir le catalogue : produits, magasins et recettes. Vos paniers et vos listes de courses sont dans le mode courses.</p>
      <button type="button" className="v2-button v2-button-primary" onClick={() => setMode("shopping")}>Passer en mode courses</button>
    </section>
  </V2PageFrame>;
}
