import { createContext, useContext } from "react";

export type CheckState = "idle" | "checking" | "current" | "available" | "offline" | "unsupported" | "error";
export type PwaUpdateValue = {
  needRefresh: boolean;
  dismissUpdate: () => void;
  checkState: CheckState;
  checkForUpdates: () => Promise<void>;
  applyUpdate: () => Promise<void>;
};
export const PwaUpdateContext = createContext<PwaUpdateValue | null>(null);

export function usePwaUpdate() {
  const context = useContext(PwaUpdateContext);
  if (!context) throw new Error("PwaUpdateProvider is missing");
  return context;
}
