import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import V2App from "./v2/V2App";
import { V2ThemeProvider } from "./v2/V2Theme";
import { PwaUpdateProvider } from "./pwa/PwaUpdateContext";
import V2PwaMount from "./pwa/V2PwaMount";
import { PwaInstallProvider } from "./pwa/PwaInstallContext";
import V2MaintenanceOverlay from "./v2/V2MaintenanceOverlay";
import "./v2/v2-base.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <V2ThemeProvider>
          <PwaUpdateProvider>
            <PwaInstallProvider>
              <V2App />
              <V2PwaMount />
              <V2MaintenanceOverlay />
            </PwaInstallProvider>
          </PwaUpdateProvider>
        </V2ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
