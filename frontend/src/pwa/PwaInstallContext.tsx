import { useEffect, useState, type ReactNode } from "react";
import { PwaInstallContext, type InstallOutcome } from "./PwaInstallState";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

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

  return <PwaInstallContext.Provider value={{
    canPrompt: installPrompt !== null, installed, isIos, requestInstall,
  }}>{children}</PwaInstallContext.Provider>;
}
