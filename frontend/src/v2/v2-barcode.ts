import { ProductApiError, productRequest } from "./v2-products-api";

type BarcodeMatch = { kind: "product" | "draft"; id: number };

/**
 * Where a barcode leads: the published product or the person's own draft, or null when our catalogue
 * does not know it (the page then reads Open Food Facts). Any other failure is thrown.
 */
export async function resolveBarcodePath(code: string): Promise<string | null> {
  try {
    const match = await productRequest<BarcodeMatch>("/by-barcode/" + code);
    return match.kind === "draft" ? "/v2/brouillons/" + match.id : "/v2/produits/" + match.id;
  } catch (reason) {
    if (reason instanceof ProductApiError && reason.status === 404) return null;
    throw reason;
  }
}

/** The product for an Open Food Facts barcode: ours, or a barcode-only one created now (signed-in only). */
export async function barcodeProduct(code: string): Promise<{ id: number; created: boolean }> {
  const response = await fetch("/api/v2/product-references", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ean: code }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload ? (payload as { detail: unknown }).detail : null;
    throw new Error(response.status === 401 ? "Connectez-vous pour ajouter ce produit." : typeof detail === "string" ? detail : "Ajout impossible. Réessayez.");
  }
  return payload as { id: number; created: boolean };
}
