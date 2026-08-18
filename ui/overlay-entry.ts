/**
 * Overlay entry point.
 * Loaded by overlay.html (transparent Tauri window).
 */

import { initOverlay } from "./overlay/overlay";
import { log } from "./shared/bridge";

// Import character animation CSS
import "./characters/ghost/animations.css";
import "./characters/cat/animations.css";
import "./overlay/overlay.css";

async function main() {
  log("overlay-entry", "nagents overlay starting");

  const el = document.getElementById("overlay");
  if (!el) {
    console.error("[overlay-entry] #overlay element not found");
    return;
  }

  await initOverlay(el);
  log("overlay-entry", "overlay initialized");
}

main().catch(console.error);
