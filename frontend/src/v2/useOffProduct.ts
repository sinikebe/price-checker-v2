import { useEffect, useState } from "react";
import { OFF_UNAVAILABLE, readOffProduct, validBarcode, type OffProduct } from "./v2-off-browser";
import { errorText } from "./v2-http";

export type OffRead = { phase: "idle" | "loading" | "missing" } | { phase: "error"; message: string } | { phase: "done"; product: OffProduct };

/**
 * One Open Food Facts read by this browser for a barcode, made when the person asked for it: a
 * barcode they searched or scanned, or the page of a product known only by its barcode. Null: no read.
 */
export function useOffProduct(code: string | null): OffRead {
  const [read, setRead] = useState<{ code: string | null; value: OffRead }>({ code: null, value: { phase: "idle" } });
  useEffect(() => {
    if (!code || !validBarcode(code)) return;
    const controller = new AbortController();
    readOffProduct(code, controller.signal)
      .then(product => { if (!controller.signal.aborted) setRead({ code, value: product ? { phase: "done", product } : { phase: "missing" } }); })
      .catch(reason => {
        if (!controller.signal.aborted) setRead({ code, value: { phase: "error", message: errorText(reason, OFF_UNAVAILABLE) } });
      });
    return () => controller.abort();
  }, [code]);
  return code && read.code === code ? read.value : { phase: code ? "loading" : "idle" };
}
