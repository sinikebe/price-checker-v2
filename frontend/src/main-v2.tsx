import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import V2App from "./v2/V2App";
import V2PwaMount from "./pwa/V2PwaMount";
import "./v2/v2-base.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <V2App />
        <V2PwaMount />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
