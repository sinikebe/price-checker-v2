/** Wording of the account security warnings (pure, so it can be unit-tested). */

function activeTokens(count: number): string {
  return count === 1 ? "votre jeton API actif" : `vos ${count} jetons API actifs`;
}

/** Shown before two-factor authentication is switched on: it ends other sessions and revokes tokens. */
export function activationWarning(activeTokenCount: number): string {
  const tokens = activeTokenCount === 0
    ? "Vous n’avez aucun jeton API actif."
    : `Elle révoque aussi ${activeTokens(activeTokenCount)}.`;
  return `L’activation de la double authentification déconnecte vos autres appareils. ${tokens}`;
}

/** Shown once two-factor authentication is on. `revokedTokenCount` is what the person had before activating. */
export function activationNotice(revokedTokenCount: number): string {
  const revoked = revokedTokenCount === 0 ? ""
    : revokedTokenCount === 1 ? " et votre jeton API a été révoqué"
    : ` et vos ${revokedTokenCount} jetons API ont été révoqués`;
  return `Double authentification activée. Vos autres appareils ont été déconnectés${revoked}. `
    + "Conservez les codes de secours hors de ce navigateur.";
}

export function disableConfirmation(activeTokenCount: number): string {
  const tokens = activeTokenCount === 0 ? ""
    : activeTokenCount === 1 ? " Votre jeton API actif sera révoqué."
    : ` Vos ${activeTokenCount} jetons API actifs seront révoqués.`;
  return `Désactiver la double authentification ?${tokens}`;
}

export const REGENERATE_CONFIRMATION = "Générer de nouveaux codes de secours ? Les anciens codes seront annulés.";
