import { logoutLocalKeys } from "./v2-account-local-keys";
import { forgetPendingInvite, sharedLookedKey } from "./v2-shared-basket";

/** Cross-tab signals in localStorage: the other tabs recheck their session when one of them changes. */
export const AUTH_CHANGED_KEY = "v2:auth:changed";
export const ACCOUNT_DELETED_KEY = "v2:account:deleted";
/** Dispatched on window once the session is known and the account's basket is active. */
export const AUTH_READY_EVENT = "v2-auth-ready";

/** After signing out: erase from this browser the account's private data and this tab's invitation state. */
export function clearSignedOutData(userId: number) {
  try {
    for (const key of logoutLocalKeys(Object.keys(localStorage), userId)) localStorage.removeItem(key);
    forgetPendingInvite();
    sessionStorage.removeItem(sharedLookedKey(userId));
  } catch { /* storage unavailable: nothing was kept */ }
}
