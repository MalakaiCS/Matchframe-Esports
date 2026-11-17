import "@fontsource/antonio/500.css";
import "@fontsource/antonio/600.css";
import "@fontsource/antonio/700.css";
import "./stage.css";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";

if (new URLSearchParams(location.search).get("demo")) document.documentElement.classList.add("demo");
createRoot(document.getElementById("root")!).render(<App />);
