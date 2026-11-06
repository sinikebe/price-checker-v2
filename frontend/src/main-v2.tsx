import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import V2App from "./v2/V2App";
import { V2ThemeProvider } from "./v2/V2Theme";
import { PwaUpdateProvider } from "./pwa/PwaUpdateContext";
import V2PwaMount from "./pwa/V2PwaMount";
import { PwaInstallProvider } from "./pwa/PwaInstallContext";
import V2MaintenanceOverlay from "./v2/V2MaintenanceOverlay";
import { V2ConfirmProvider } from "./v2/V2ConfirmProvider";
import "./v2/v2-base.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <V2ThemeProvider>
        <PwaUpdateProvider>
          <PwaInstallProvider>
            <V2ConfirmProvider>
              <V2App />
              <V2PwaMount />
              <V2MaintenanceOverlay />
            </V2ConfirmProvider>
          </PwaInstallProvider>
        </PwaUpdateProvider>
      </V2ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
