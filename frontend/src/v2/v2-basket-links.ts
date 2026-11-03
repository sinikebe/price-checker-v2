import { createContext } from "react";

/**
 * Whether the articles of a basket link to their catalogue pages. The app's own demo turns this off: its
 * products and stores are fictional and have no page.
 */
export const BasketLinksContext = createContext(true);
