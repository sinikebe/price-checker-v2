import { createContext, useContext } from "react";

export type ConfirmOptions = {
  /** The question, in a sentence. A blank line starts a new paragraph. */
  message: string;
  title?: string;
  /** The button that goes ahead: say what it does ("Supprimer", "Publier"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** A destructive action: the button reads as one. */
  danger?: boolean;
};
export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

export const ConfirmContext = createContext<Confirm>(() => Promise.resolve(false));

/**
 * Asks before an action, in the page itself (never a browser dialog, which blocks the page and the
 * tools that read it). Resolves true when the action is confirmed.
 */
export const useConfirm = () => useContext(ConfirmContext);
