import { useAppMode } from "./useAppMode";

/** In the header while the contribution mode is on: says so, and goes back to shopping in one tap. */
export default function V2ModeBadge() {
  const { mode, setMode } = useAppMode();
  if (mode !== "contribute") return null;
  return <button type="button" className="v2-mode-badge" title="Revenir au mode courses"
    aria-label="Mode contribution activé. Revenir au mode courses" onClick={() => setMode("shopping")}>
    <span aria-hidden="true" className="v2-mode-badge-dot" />Contribution<span aria-hidden="true" className="v2-mode-badge-close">×</span>
  </button>;
}
