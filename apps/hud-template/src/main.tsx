import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles/app.scss";

if (new URLSearchParams(location.search).get("demo") === "1") document.documentElement.classList.add("demo");
createRoot(document.getElementById("root")!).render(<App />);
