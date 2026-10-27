import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./components/toasts.tsx";
import { CaptainPage } from "./screens/Captain.tsx";
import "./styles.css";

// Standalone captain veto page: the only page the engine serves to browsers (scoped captain links).
// It contains no operator console code.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <CaptainPage />
    </ToastProvider>
  </StrictMode>,
);
