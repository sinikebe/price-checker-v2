import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.9"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;
}

export const HomeIcon = () => <Icon><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9.5h13V10" /><path d="M10 19.5v-5h4v5" /></Icon>;
export const ProductsIcon = () => <Icon><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></Icon>;
export const StoreIcon = () => <Icon><path d="M4 9.5 5.5 4h13L20 9.5" /><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" /><path d="M5.5 12.5V20h13v-7.5" /><path d="M10 20v-4.5h4V20" /></Icon>;
export const RecipesIcon = () => <Icon><path d="M12 6.5C10.3 5.2 8 4.7 4.5 4.8v13c3.5-.1 5.8.4 7.5 1.7 1.7-1.3 4-1.8 7.5-1.7v-13C16 4.7 13.7 5.2 12 6.5Z" /><path d="M12 6.5v13" /></Icon>;
export const CartIcon = () => <Icon><path d="M3.5 4.5H6l2 10.5h9.5l2-7.5H7.2" /><circle cx="9.5" cy="19.2" r="1.3" /><circle cx="17" cy="19.2" r="1.3" /></Icon>;
export const PersonIcon = () => <Icon><circle cx="12" cy="8.5" r="3.6" /><path d="M4.8 20c.8-3.7 3.7-5.8 7.2-5.8s6.4 2.1 7.2 5.8" /></Icon>;
export const SearchIcon = () => <Icon><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></Icon>;
export const ChevronLeftIcon = () => <Icon><path d="M14.5 5.5 8 12l6.5 6.5" /></Icon>;
export const CloseIcon = () => <Icon><path d="M6 6l12 12M18 6 6 18" /></Icon>;
export const BarcodeIcon = () => <Icon><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" /><path d="M7.5 9v6M10.5 9v6M13.5 9v6M16.5 9v6" /></Icon>;
