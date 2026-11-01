/** Pure helpers of the connector settings form (kept free of React so they can be unit-tested). */
export type SettingField = { key: string; label: string; type: "boolean" | "integer" | "secret";
  min?: number; max?: number; configured?: boolean };
export type SettingValue = boolean | number | string;

/** What the server may send back: never the value of a secret field. */
export function readableValues(fields: readonly SettingField[], values: Record<string, SettingValue>): Record<string, SettingValue> {
  const secret = new Set(fields.filter(field => field.type === "secret").map(field => field.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => !secret.has(key)));
}

/** The form's starting point: the saved values and an empty entry for each secret (empty means keep). */
export function initialDraft(fields: readonly SettingField[], values: Record<string, SettingValue>): Record<string, SettingValue> {
  return { ...readableValues(fields, values), ...Object.fromEntries(fields.filter(field => field.type === "secret").map(field => [field.key, ""])) };
}

/** What is sent: every field once, secrets as typed ("" when left empty so the stored one stays). */
export function settingsPayload(fields: readonly SettingField[], draft: Record<string, SettingValue>): Record<string, SettingValue> {
  return Object.fromEntries(fields.map(field => [field.key, field.type === "secret"
    ? (typeof draft[field.key] === "string" ? draft[field.key] : "")
    : draft[field.key]]));
}

export function secretHint(field: SettingField): string {
  return field.configured ? "Clé enregistrée : laissez vide pour la conserver." : "Aucune clé enregistrée.";
}
