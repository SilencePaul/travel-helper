import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRoot } from "./app/BrowserRoot";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRoot />
  </StrictMode>,
);
