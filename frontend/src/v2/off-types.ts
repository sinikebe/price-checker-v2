export type OffFieldKind =
  | "text"
  | "tags"
  | "number"
  | "link"
  | "image"
  | "timestamp"
  | "json";

export interface OffField {
  // The original OFF key, kept next to the translated label: the label is
  // French and the key is not, so the key is what you need to look a field up
  // in OFF's own docs or to file an unambiguous bug about it.
  key: string;
  label: string;
  kind: OffFieldKind;
  // Exactly one is populated, selected by `kind`.
  text: string | null;
  tags: string[];
  number: number | null;
  url: string | null;
  timestamp: string | null;
  json_value: unknown;
}

export interface OffNutriment {
  key: string;
  label: string;
  per_100g: number | null;
  per_serving: number | null;
  unit: string | null;
  // OFF's "<", "~", ">=" — a trace recorded as "< 0.5" must not render as a
  // flat 0.5, which would read as a measurement.
  modifier: string | null;
  // OFF's own coarse judgement, and only for the four nutrients it grades.
  level: "low" | "moderate" | "high" | string | null;
}

export interface OffImage {
  key: string;
  label: string;
  url: string;
  thumb_url: string | null;
}

export interface OffSection {
  id: string;
  title: string;
  kind: "fields" | "nutriments" | "images" | "raw";
  fields: OffField[];
  nutriments: OffNutriment[];
  images: OffImage[];
  // Only for kind === "raw": every key no curated section claimed. This is what
  // makes "all of it" true rather than aspirational.
  raw: Record<string, unknown>;
  collapsed: boolean;
}
