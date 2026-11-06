import { createContext, useContext } from "react";
import type { AppMode } from "./v2-site-nav";

export type AppModeValue = {
  mode: AppMode;
  /** Only a signed-in account can switch to the contribution mode. */
  canSwitch: boolean;
  setMode: (mode: AppMode) => void;
};

export const AppModeContext = createContext<AppModeValue>({ mode: "shopping", canSwitch: false, setMode: () => undefined });

/** The mode in use on this page: shopping (baskets and lists) or contribution (products, stores, recipes). */
export const useAppMode = () => useContext(AppModeContext);
