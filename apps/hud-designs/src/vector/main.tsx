import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/800.css";
import "./vector.css";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";

if (new URLSearchParams(location.search).get("demo")) document.documentElement.classList.add("demo");
createRoot(document.getElementById("root")!).render(<App />);
