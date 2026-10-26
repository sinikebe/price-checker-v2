import { createContext, useContext } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export const ThemeContext = createContext<{ choice: ThemeChoice; setChoice: (choice: ThemeChoice) => void } | null>(null);

export function useV2Theme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("V2ThemeProvider is missing");
  return context;
}
