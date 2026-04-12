import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import SmartApp from "./SmartApp";
import { AppErrorBoundary } from "./components/AppErrorBoundary";

// Self-hosted fonts (bundled by Vite from node_modules)
import "@fontsource-variable/fraunces";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <SmartApp />
    </AppErrorBoundary>
  </StrictMode>,
);
