import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRoot } from "./app/BrowserRoot";
import { registerSW } from "virtual:pwa-register";

registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRoot />
  </StrictMode>,
);
