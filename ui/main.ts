/**
 * Panel entry point.
 * Loaded by index.html (main Tauri window).
 */

import { initPanel } from "./panel/panel";
import { log } from "./shared/bridge";

// Import character animation CSS (all 10 characters)
import "./characters/ghost/animations.css";
import "./characters/cat/animations.css";
import "./characters/skeleton/animations.css";
import "./characters/robot/animations.css";
import "./characters/owl/animations.css";
import "./characters/mushroom/animations.css";
import "./characters/flame/animations.css";
import "./characters/crystal/animations.css";
import "./characters/cloud/animations.css";
import "./characters/blob/animations.css";
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
