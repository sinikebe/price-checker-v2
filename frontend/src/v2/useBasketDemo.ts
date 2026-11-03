import { useEffect, useMemo, useState } from "react";
import { basketItemKey, type BasketItem, type BasketQuantity } from "./v2-basket-storage";
import { demoItems, initialDemoState, readDemoState, writeDemoState, type DemoSource, type DemoState } from "./v2-basket-demo";
import type { SharedSettings } from "./v2-shared-basket";

/**
 * A demo basket as the visitor plays with it: its articles and its settings, kept in this tab only
 * (session storage), so the demo and its list stay in step and start again with a new tab or a new demo.
 */
export function useBasketDemo(source: DemoSource) {
  const [state, setState] = useState<DemoState>(() => readDemoState(source));
  if (state.source !== source.id) setState(readDemoState(source));
  useEffect(() => { writeDemoState(state); }, [state]);
  const items = useMemo(() => demoItems(state, source), [state, source]);
  const start = useMemo(() => JSON.stringify(initialDemoState(source)), [source]);
  const lines = (change: (lines: DemoState["lines"]) => DemoState["lines"]) => setState(current => ({ ...current, lines: change(current.lines) }));
  const update = (item: BasketItem, patch: Partial<DemoState["lines"][number]>) => {
    const key = basketItemKey(item);
    lines(current => current.map(line => line.key === key ? { ...line, ...patch } : line));
  };
  return {
    items,
    settings: state.settings,
    setSettings: (patch: Partial<SharedSettings>) => setState(current => ({ ...current, settings: { ...current.settings, ...patch } })),
    actions: {
      setEnabled: (item: BasketItem, enabled: boolean) => update(item, { disabled: !enabled }),
      setQuantity: (item: BasketItem, quantity: BasketQuantity | undefined) => update(item, { quantity: quantity ?? null }),
      // A demo has no other comparison choice to offer.
      replace: () => undefined,
      remove: (item: BasketItem) => { const key = basketItemKey(item); lines(current => current.filter(line => line.key !== key)); },
      clear: () => lines(() => []),
    },
    /** Back to the demo as it was saved. */
    reset: () => setState(initialDemoState(source)),
    changed: JSON.stringify(state) !== start,
  };
}
