import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
export type InstallOutcome = "accepted" | "dismissed" | "ios" | "manual" | "installed" | "error";
type InstallState = {
  canPrompt: boolean;
  installed: boolean;
  isIos: boolean;
  requestInstall: () => Promise<InstallOutcome>;
};

const Context = createContext<InstallState | null>(null);
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const ready = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const done = () => { setInstallPrompt(null); setInstalled(true); };
    const displayChanged = () => setInstalled(isStandalone());
    window.addEventListener("beforeinstallprompt", ready);
    window.addEventListener("appinstalled", done);
    displayMode.addEventListener("change", displayChanged);
    return () => {
      window.removeEventListener("beforeinstallprompt", ready);
      window.removeEventListener("appinstalled", done);
      displayMode.removeEventListener("change", displayChanged);
    };
  }, []);

  async function requestInstall(): Promise<InstallOutcome> {
    if (installed) return "installed";
    if (!installPrompt) return isIos ? "ios" : "manual";
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      return choice.outcome === "accepted" ? "accepted" : "dismissed";
    } catch {
      setInstallPrompt(null);
      return "error";
    }
  }

  return <Context.Provider value={{
    canPrompt: installPrompt !== null, installed, isIos, requestInstall,
  }}>{children}</Context.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePwaInstall() {
  const value = useContext(Context);
  if (!value) throw new Error("usePwaInstall needs PwaInstallProvider");
  return value;
}
