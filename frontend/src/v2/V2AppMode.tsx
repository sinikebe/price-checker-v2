import { useCallback, useMemo, useState, type ReactNode } from "react";
import { AppModeContext } from "./useAppMode";
import { readAppMode, writeAppMode } from "./v2-app-mode";
import type { AppMode } from "./v2-site-nav";

function storage() {
  try { return window.localStorage; } catch { return null; }
}

/** The mode of the signed-in account on this device; a visitor always shops. */
export function V2AppModeProvider({ userId, children }: { userId: number | null; children: ReactNode }) {
  const [chosen, setChosen] = useState<{ userId: number | null; mode: AppMode } | null>(null);
  const mode = chosen && chosen.userId === userId ? chosen.mode : readAppMode(storage(), userId);
  const setMode = useCallback((next: AppMode) => {
    if (!userId) return;
    writeAppMode(storage(), userId, next);
    setChosen({ userId, mode: next });
  }, [userId]);
  const value = useMemo(() => ({ mode, canSwitch: userId !== null, setMode }), [mode, userId, setMode]);
  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
}
