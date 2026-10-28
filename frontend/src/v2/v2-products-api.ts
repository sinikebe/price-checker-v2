import { cacheApprovedProduct } from "../pwa/cache-writes";
import type { OffSection } from "./off-types";

export type OffField = "name" | "brand" | "composition" | "quantity" | "ean" | "nutriscore" | "nova";
export type OffSource = { code: string; checked_at: string; fields: OffField[] };
export type OffSuggestion = {
  code: string | null; product_name: string | null; brand: string | null;
  quantity: string | null; ingredients_text: string | null; image_url: string | null;
  nutriscore_grade: string | null; nova_group: number | null;
  nutriscore_version: string | null;
};
export type RetailerLink = { retailer: string; url: string; source: "manual" | "capture" };
export type ProductData = {
  name: string; brand: string; commercial_name: string; composition: string;
  package: string; quantity: string; ean: string; group: string; tags: string[];
  retailer_links: RetailerLink[]; notes: string;
  nutrition_checked_at: string | null; quantity_amount: string | null;
  quantity_unit: "g" | "ml" | "piece" | null; quantity_count_noun: string | null;
  nutriscore: string; nova: string; nutriscore_version: string;
  off_source: OffSource | null;
};
export type ChangeKind = "correction" | "new_version";
export type Product = {
  id: number; data: ProductData; revision: number; predecessor_id: number | null;
  updated_at: string; successor_id?: number | null; merged_to_id?: number | null;
};
export type Draft = {
  id: number; product_id: number | null; author_id: number; author?: string | null;
  data: ProductData; base_revision: number | null; revision: number;
  status: "draft" | "approved" | "rejected"; change_kind: ChangeKind;
  updated_at: string; result_product_id: number | null; successor_id?: number | null;
  linked_prices?: { id: number; price: string; status: "draft" | "approved" | "rejected";
    capture_ean: string | null; quantity_text: string | null; captured_store_name: string | null;
    retailer: string; store_name: string }[];
};
export type V2OffSnapshot = {
  product_id: number; barcode: string; fetched_at: string;
  off_rev: number | null; off_last_modified: string | null; off_url: string;
  field_count: number; presented_field_count: number; sections: OffSection[];
};
export type ProductEvent = {
  id: number; event_type: string; created_at: string;
  before: ProductData | null; after: ProductData;
};
export const emptyProduct = (): ProductData => ({
  name: "", brand: "", commercial_name: "", composition: "", package: "",
  quantity: "", ean: "", group: "", tags: [], retailer_links: [], notes: "",
  nutrition_checked_at: null, quantity_amount: null, quantity_unit: null, quantity_count_noun: null,
  nutriscore: "", nova: "",
  nutriscore_version: "", off_source: null,
});
export function completeProductData(value: Partial<ProductData>): ProductData {
  const tags = typeof value.tags === "string" ? (value.tags as string).split(",").map(tag => tag.trim()).filter(Boolean)
    : Array.isArray(value.tags) ? value.tags : [];
  return { ...emptyProduct(), ...value, tags, retailer_links: Array.isArray(value.retailer_links) ? value.retailer_links : [] };
}
export class ProductApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function productRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch("/api/v2/products" + path, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data
      ? (data as { detail: unknown }).detail : null;
    throw new ProductApiError(typeof detail === "string" ? detail : "L'opération a échoué.", response.status);
  }
  const result = await response.json() as T;
  if (method === "POST" && /^\/drafts\/\d+\/approve$/.test(path)) await cacheApprovedProduct(result as Product);
  return result;
}
