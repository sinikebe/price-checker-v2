import { createContext, useContext } from "react";

export type InstallOutcome = "accepted" | "dismissed" | "ios" | "manual" | "installed" | "error";
export type InstallState = {
  canPrompt: boolean;
  installed: boolean;
  isIos: boolean;
  requestInstall: () => Promise<InstallOutcome>;
};

export const PwaInstallContext = createContext<InstallState | null>(null);

export function usePwaInstall() {
  const value = useContext(PwaInstallContext);
  if (!value) throw new Error("usePwaInstall needs PwaInstallProvider");
  return value;
}
