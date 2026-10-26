import { useLayoutEffect, useState, type ReactNode } from "react";
import { ThemeContext, type ThemeChoice } from "./V2ThemeContext";
import "./v2-dark.css";

const STORAGE_KEY = "price-checker-v2-theme";

function savedChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function V2ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(savedChoice);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);

  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useLayoutEffect(() => {
    const dark = choice === "dark" || (choice === "system" && systemDark);
    document.documentElement.dataset.v2Theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#101b19" : "#2f8061");
    try { localStorage.setItem(STORAGE_KEY, choice); } catch { /* Private browsing can disable storage. */ }
  }, [choice, systemDark]);

  return <ThemeContext.Provider value={{ choice, setChoice }}>{children}</ThemeContext.Provider>;
}
