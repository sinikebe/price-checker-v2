import type { V2User } from "./v2-auth-api";

/**
 * The account last signed in on this browser, kept so the app still knows it offline (its baskets,
 * prices and lists are kept under its id). The key ends with the account id: signing out or deleting
 * the account removes it with the account's other local data.
 */
export const offlineUserKey = (userId: number) => `v2:auth:offline-user:${userId}`;

export function rememberOfflineUser(user: V2User) {
  try { localStorage.setItem(offlineUserKey(user.id), JSON.stringify({ id: user.id, username: user.username, role: user.role })); }
  catch { /* offline, the app opens signed out */ }
}

/** The account kept for `userId` (the account whose basket this browser shows), or null. */
export function offlineUser(userId: number | null): V2User | null {
  if (!userId) return null;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(offlineUserKey(userId)) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { id, username, role } = value as Record<string, unknown>;
    return id === userId && typeof username === "string" && username && (role === "admin" || role === "confirmed" || role === "visitor")
      ? { id, username, role } : null;
  } catch { return null; }
}
