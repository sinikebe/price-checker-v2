/** Pure logic of the settings tabs (no React, so it can be unit-tested). */

export type SettingsTabId = "general" | "account" | "security" | "connectors" | "server";
export type SettingsViewer = { loggedIn: boolean; admin: boolean };
type Access = "everyone" | "member" | "admin";

export type SettingsTab = { id: SettingsTabId; slug: string; label: string; access: Access };

export const SETTINGS_BASE_PATH = "/v2/parametres";

/** Display order. The first tab is the default one and lives at the bare settings path. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "general", slug: "general", label: "Général", access: "everyone" },
  { id: "account", slug: "compte", label: "Compte", access: "member" },
  { id: "security", slug: "securite", label: "Sécurité", access: "member" },
  { id: "connectors", slug: "connecteurs", label: "Connecteurs", access: "admin" },
  { id: "server", slug: "serveur", label: "Serveur", access: "admin" },
];

function allowed(tab: SettingsTab, viewer: SettingsViewer): boolean {
  if (tab.access === "everyone") return true;
  if (tab.access === "member") return viewer.loggedIn;
  return viewer.loggedIn && viewer.admin;
}

export function visibleSettingsTabs(viewer: SettingsViewer): SettingsTab[] {
  return SETTINGS_TABS.filter(tab => allowed(tab, viewer));
}

/** DOM ids linking a tab to its panel (aria-controls / aria-labelledby). */
export const settingsTabDomId = (id: SettingsTabId) => `v2-settings-tab-${id}`;
export const settingsPanelDomId = (id: SettingsTabId) => `v2-settings-panel-${id}`;

/** The default tab is reached at the bare path; the others at `<base>/<slug>`. */
export function settingsTabPath(id: SettingsTabId): string {
  const tab = SETTINGS_TABS.find(item => item.id === id) ?? SETTINGS_TABS[0];
  return tab === SETTINGS_TABS[0] ? SETTINGS_BASE_PATH : `${SETTINGS_BASE_PATH}/${tab.slug}`;
}

/**
 * Picks the tab for the URL segment after the base path (undefined for the bare path).
 * `redirect` is true when the URL is not the canonical one for what is displayed: an unknown
 * slug, a tab this viewer may not see, or the default tab's own slug.
 */
export function resolveSettingsTab(slug: string | undefined, viewer: SettingsViewer): { tab: SettingsTab; redirect: boolean } {
  const first = SETTINGS_TABS[0];
  if (slug === undefined) return { tab: first, redirect: false };
  const requested = SETTINGS_TABS.find(tab => tab.slug === slug);
  if (!requested || requested === first || !allowed(requested, viewer)) return { tab: first, redirect: true };
  return { tab: requested, redirect: false };
}

/** Keyboard navigation of a tab list: the index to focus after `key`, or null when the key is not handled. */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight": return (current + 1) % count;
    case "ArrowLeft": return (current - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}
