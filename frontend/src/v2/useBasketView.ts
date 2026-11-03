import { useState } from "react";
import { emptyBasketFilters, type BasketFilters, type CompareMode } from "./v2-basket-comparison";
import { readBasketDefaultStores } from "./v2-basket-default-stores";
import { readStoresOff, writeStoresOff } from "./v2-basket-store-off";
import { readUnitChoices, writeUnitChoices, type UnitChoiceMap } from "./v2-measures";
import type { SharedSettings } from "./v2-shared-basket";
import { listSetting, listViewOf, type ListView } from "./v2-shopping-list";

export type BasketView = {
  advanced: boolean; setAdvanced: (value: boolean) => void;
  mode: CompareMode; setMode: (value: CompareMode) => void;
  units: UnitChoiceMap; setUnits: (value: UnitChoiceMap) => void;
  storesOff: string[]; setStoresOff: (value: string[]) => void;
  filters: BasketFilters; setFilters: (value: BasketFilters) => void;
  /** Articles ticked in the shopping list. */
  checked: string[]; setChecked: (value: string[]) => void;
  /** The list: all articles, split across stores, or one store (shared live in a shared basket). */
  listView: ListView; setListView: (value: ListView) => void;
};
type SharedView = {
  settings: SharedSettings; setSettings: (patch: Partial<SharedSettings>) => void;
  /** Ticks sent one article at a time (a shared basket); without it, the ticks are a setting like the others. */
  setChecked?: (keys: string[]) => void;
};

function readFlag(key: string, on: string): boolean { try { return localStorage.getItem(key) === on; } catch { return false; } }
function writeValue(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* this page still works */ } }
const checkedKey = (userId: number | null) => `v2:basket:checked:${userId ?? "anonymous"}`;
const listModeKey = (userId: number | null) => `v2:basket:list-mode:${userId ?? "anonymous"}`;
function readListMode(userId: number | null): string { try { return localStorage.getItem(listModeKey(userId)) ?? "all"; } catch { return "all"; } }
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
  const [listState, setListState] = useState(() => ({ userId, mode: readListMode(userId) }));
  if (listState.userId !== userId) setListState({ userId, mode: readListMode(userId) });
  const [filters, setFilters] = useState<BasketFilters>(() => ({ ...emptyBasketFilters, storeIds: readBasketDefaultStores().map(store => store.id) }));
  if (shared) return {
    advanced: shared.settings.advanced, setAdvanced: value => shared.setSettings({ advanced: value }),
    mode: shared.settings.compare, setMode: value => shared.setSettings({ compare: value }),
    units: shared.settings.units, setUnits: value => shared.setSettings({ units: value }),
    storesOff: shared.settings.stores_off, setStoresOff: value => shared.setSettings({ stores_off: value }),
    filters: shared.settings.filters, setFilters: value => shared.setSettings({ filters: value }),
    checked: shared.settings.checked,
    setChecked: value => shared.setChecked ? shared.setChecked(value.slice(0, 100)) : shared.setSettings({ checked: value.slice(0, 100) }),
    listView: listViewOf(shared.settings.list_mode), setListView: value => shared.setSettings({ list_mode: listSetting(value) }),
  };
  return {
    advanced, setAdvanced: value => { setAdvancedState(value); writeValue("v2:basket:advanced", value ? "1" : "0"); },
    mode, setMode: value => { setModeState(value); writeValue("v2:basket:compare", value); },
    units: unitState.choices, setUnits: value => { setUnitState({ userId, choices: value }); writeUnitChoices(userId, value); },
    storesOff: offState.keys, setStoresOff: value => { setOffState({ userId, keys: value }); writeStoresOff(userId, value); },
    filters, setFilters,
    checked: checkedState.keys, setChecked: value => { const keys = value.slice(0, 100); setCheckedState({ userId, keys }); writeValue(checkedKey(userId), JSON.stringify(keys)); },
    listView: listViewOf(listState.mode), setListView: value => { const mode = listSetting(value); setListState({ userId, mode }); writeValue(listModeKey(userId), mode); },
  };
}
