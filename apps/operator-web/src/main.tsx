import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { initLanguage } from "./i18n/language.ts";
import "./styles.css";

// The saved language loads before the first render (no flash of English).
void initLanguage().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
