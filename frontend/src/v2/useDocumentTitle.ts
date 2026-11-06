import { useEffect } from "react";

/** Show `title` in the browser tab while the page is open, then give back the title it had before. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
}
