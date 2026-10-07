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
import "./characters/wisp/animations.css";
import "./characters/spark/animations.css";
import "./characters/orb/animations.css";
import "./characters/fox/animations.css";
import "./characters/penguin/animations.css";
import "./characters/panda/animations.css";
import "./characters/bee/animations.css";
import "./characters/frog/animations.css";
import "./characters/snail/animations.css";
import "./characters/turtle/animations.css";
import "./characters/fish/animations.css";
import "./characters/octopus/animations.css";
import "./characters/dragon/animations.css";
import "./characters/unicorn/animations.css";
import "./characters/bat/animations.css";
import "./characters/hedgehog/animations.css";
import "./characters/hamster/animations.css";
import "./characters/raccoon/animations.css";
import "./characters/koala/animations.css";
import "./characters/cactus/animations.css";
import "./characters/sunflower/animations.css";
import "./characters/acorn/animations.css";
import "./characters/leaf/animations.css";
import "./characters/planet/animations.css";
import "./characters/moon/animations.css";
import "./characters/star/animations.css";
import "./characters/comet/animations.css";
import "./characters/alien/animations.css";
import "./characters/ufo/animations.css";
import "./characters/dna/animations.css";
import "./characters/atom/animations.css";
import "./characters/potion/animations.css";
import "./characters/scroll/animations.css";
import "./characters/shield/animations.css";
import "./characters/diamond/animations.css";
import "./characters/crown/animations.css";
import "./characters/heart/animations.css";
import "./characters/lightning/animations.css";
import "./characters/raindrop/animations.css";
import "./characters/snowflake/animations.css";
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
