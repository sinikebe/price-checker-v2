import { ProductApiError, productRequest } from "./v2-products-api";

type BarcodeMatch = { kind: "product" | "draft"; id: number };

/**
 * Where a barcode leads: the published product, the person's own draft, or a new product
 * prepared with this barcode when it is unknown. Any other failure is thrown.
 */
export async function resolveBarcodePath(code: string): Promise<string> {
  try {
    const match = await productRequest<BarcodeMatch>("/by-barcode/" + code);
    return match.kind === "draft" ? "/v2/brouillons/" + match.id : "/v2/produits/" + match.id;
  } catch (reason) {
    if (reason instanceof ProductApiError && reason.status === 404) return "/v2/produits/nouveau?ean=" + encodeURIComponent(code);
    throw reason;
  }
}
