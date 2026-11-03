import { useState } from "react";
import { emptyBasketFilters, type BasketFilters, type CompareMode } from "./v2-basket-comparison";
import { readBasketDefaultStores } from "./v2-basket-default-stores";
import { readStoresOff, writeStoresOff } from "./v2-basket-store-off";
import { readUnitChoices, writeUnitChoices, type UnitChoiceMap } from "./v2-measures";
import type { SharedSettings } from "./v2-shared-basket";

export type BasketView = {
  advanced: boolean; setAdvanced: (value: boolean) => void;
  mode: CompareMode; setMode: (value: CompareMode) => void;
  units: UnitChoiceMap; setUnits: (value: UnitChoiceMap) => void;
  storesOff: string[]; setStoresOff: (value: string[]) => void;
  filters: BasketFilters; setFilters: (value: BasketFilters) => void;
  /** Articles ticked in the shopping list. */
  checked: string[]; setChecked: (value: string[]) => void;
};
type SharedView = { settings: SharedSettings; setSettings: (patch: Partial<SharedSettings>) => void };

function readFlag(key: string, on: string): boolean { try { return localStorage.getItem(key) === on; } catch { return false; } }
function writeValue(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* this page still works */ } }
const checkedKey = (userId: number | null) => `v2:basket:checked:${userId ?? "anonymous"}`;
/** The ticked articles kept in this browser: basket keys, once each, at most 100. */
export function readChecked(userId: number | null): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(checkedKey(userId)) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 400))].slice(0, 100) : [];
  } catch { return []; }
}

/**
 * How a basket is shown: quantities, price or unit price, the unit of each article, the stores
 * switched off and the store filters. The personal basket keeps them in this browser; a shared
 * basket keeps them on the server, the same for every member and changed live.
 */
export function useBasketView(userId: number | null, shared: SharedView | null): BasketView {
  const [advanced, setAdvancedState] = useState(() => readFlag("v2:basket:advanced", "1"));
  const [mode, setModeState] = useState<CompareMode>(() => readFlag("v2:basket:compare", "unit") ? "unit" : "price");
  const [unitState, setUnitState] = useState(() => ({ userId, choices: readUnitChoices(userId) }));
  if (unitState.userId !== userId) setUnitState({ userId, choices: readUnitChoices(userId) });
  const [offState, setOffState] = useState(() => ({ userId, keys: readStoresOff(userId) }));
  if (offState.userId !== userId) setOffState({ userId, keys: readStoresOff(userId) });
  const [checkedState, setCheckedState] = useState(() => ({ userId, keys: readChecked(userId) }));
  if (checkedState.userId !== userId) setCheckedState({ userId, keys: readChecked(userId) });
  const [filters, setFilters] = useState<BasketFilters>(() => ({ ...emptyBasketFilters, storeIds: readBasketDefaultStores().map(store => store.id) }));
  if (shared) return {
    advanced: shared.settings.advanced, setAdvanced: value => shared.setSettings({ advanced: value }),
    mode: shared.settings.compare, setMode: value => shared.setSettings({ compare: value }),
    units: shared.settings.units, setUnits: value => shared.setSettings({ units: value }),
    storesOff: shared.settings.stores_off, setStoresOff: value => shared.setSettings({ stores_off: value }),
    filters: shared.settings.filters, setFilters: value => shared.setSettings({ filters: value }),
    checked: shared.settings.checked, setChecked: value => shared.setSettings({ checked: value.slice(0, 100) }),
  };
  return {
    advanced, setAdvanced: value => { setAdvancedState(value); writeValue("v2:basket:advanced", value ? "1" : "0"); },
    mode, setMode: value => { setModeState(value); writeValue("v2:basket:compare", value); },
    units: unitState.choices, setUnits: value => { setUnitState({ userId, choices: value }); writeUnitChoices(userId, value); },
    storesOff: offState.keys, setStoresOff: value => { setOffState({ userId, keys: value }); writeStoresOff(userId, value); },
    filters, setFilters,
    checked: checkedState.keys, setChecked: value => { const keys = value.slice(0, 100); setCheckedState({ userId, keys }); writeValue(checkedKey(userId), JSON.stringify(keys)); },
  };
}
