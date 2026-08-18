/**
 * Panel entry point.
 * Loaded by index.html (main Tauri window).
 */

import { initPanel } from "./panel/panel";
import { log } from "./shared/bridge";

// Import character animation CSS
import "./characters/ghost/animations.css";
import "./characters/cat/animations.css";
import "./panel/panel.css";

async function main() {
  log("main", "nagents panel starting");

  const el = document.getElementById("app");
  if (!el) {
    console.error("[main] #app element not found");
    return;
  }

  await initPanel(el);
  log("main", "panel initialized");
}

main().catch(console.error);
