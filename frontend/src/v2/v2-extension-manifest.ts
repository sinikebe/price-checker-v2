/** The manifest of the extension copy an instance hands out (pure, so it can be tested on its own). */
/** An origin the manifest may name: https, or http on this machine. Anything else is refused. */
export function validInstance(value: string): boolean {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    // Letters, digits, dots and dashes only: no wildcard, no brackets, nothing a host pattern could widen.
    return url.origin === value && /^[A-Za-z0-9.-]+$/.test(url.hostname) && (url.protocol === "https:" || (local && url.protocol === "http:"));
  } catch { return false; }
}

/** The manifest of the copy handed out by an instance: it also reads that instance's own pages, so the
 *  basket page and the extension can talk without any setting or token. */
export function instanceManifest(baseText: string, instance: string): string {
  if (!validInstance(instance)) throw new Error("Adresse d’instance invalide.");
  const base = JSON.parse(baseText) as { host_permissions: string[]; content_scripts: object[] };
  const pattern = instance + "/*";
  return JSON.stringify({
    ...base,
    host_permissions: [...base.host_permissions, pattern],
    content_scripts: [...base.content_scripts, { matches: [pattern], js: ["extension-core.js", "app-bridge.js"], run_at: "document_start" }],
  }, null, 2) + "\n";
}
