/**
 * Character Registry — discovers and provides access to all registered characters.
 *
 * To add a character:
 *   1. Create ui/characters/<id>/ with manifest.ts, <id>.svg, animations.css
 *   2. Import and register below
 *
 * That's it. The panel/overlay looks up characters by ID from here.
 */

import type { CharacterDef } from "./types";
import { ghost } from "./ghost/manifest";
import { cat } from "./cat/manifest";
import { skeleton } from "./skeleton/manifest";
import { robot } from "./robot/manifest";
import { owl } from "./owl/manifest";
import { mushroom } from "./mushroom/manifest";
import { flame } from "./flame/manifest";
import { crystal } from "./crystal/manifest";
import { cloud } from "./cloud/manifest";
import { blob } from "./blob/manifest";
import { wisp } from "./wisp/manifest";
import { spark } from "./spark/manifest";
import { orb } from "./orb/manifest";
import { fox } from "./fox/manifest";
import { penguin } from "./penguin/manifest";
import { panda } from "./panda/manifest";
import { bee } from "./bee/manifest";
import { frog } from "./frog/manifest";
import { snail } from "./snail/manifest";
import { turtle } from "./turtle/manifest";
import { fish } from "./fish/manifest";
import { octopus } from "./octopus/manifest";
import { dragon } from "./dragon/manifest";
import { unicorn } from "./unicorn/manifest";
import { bat } from "./bat/manifest";
import { hedgehog } from "./hedgehog/manifest";
import { hamster } from "./hamster/manifest";
import { raccoon } from "./raccoon/manifest";
import { koala } from "./koala/manifest";
import { cactus } from "./cactus/manifest";
import { sunflower } from "./sunflower/manifest";
import { acorn } from "./acorn/manifest";
import { leaf } from "./leaf/manifest";
import { planet } from "./planet/manifest";
import { moon } from "./moon/manifest";
import { star } from "./star/manifest";
import { comet } from "./comet/manifest";
import { alien } from "./alien/manifest";
import { ufo } from "./ufo/manifest";
import { dna } from "./dna/manifest";
import { atom } from "./atom/manifest";
import { potion } from "./potion/manifest";
import { scroll } from "./scroll/manifest";
import { shield } from "./shield/manifest";
import { diamond } from "./diamond/manifest";
import { crown } from "./crown/manifest";
import { heart } from "./heart/manifest";
import { lightning } from "./lightning/manifest";
import { raindrop } from "./raindrop/manifest";
import { snowflake } from "./snowflake/manifest";

// ─── Registry ───────────────────────────────────────────────────────────────

const CHARACTERS: CharacterDef[] = [
  ghost,
  cat,
  skeleton,
  robot,
  owl,
  mushroom,
  flame,
  crystal,
  cloud,
  blob,
  wisp,
  spark,
  orb,
  fox,
  penguin,
  panda,
  bee,
  frog,
  snail,
  turtle,
  fish,
  octopus,
  dragon,
  unicorn,
  bat,
  hedgehog,
  hamster,
  raccoon,
  koala,
  cactus,
  sunflower,
  acorn,
  leaf,
  planet,
  moon,
  star,
  comet,
  alien,
  ufo,
  dna,
  atom,
  potion,
  scroll,
  shield,
  diamond,
  crown,
  heart,
  lightning,
  raindrop,
  snowflake,
];

const charMap = new Map<string, CharacterDef>(
  CHARACTERS.map((c) => [c.id, c])
);

/** Get character by ID. Falls back to ghost if not found. */
export function getCharacter(id: string): CharacterDef {
  return charMap.get(id) ?? charMap.get("ghost")!;
}

/** List all registered characters. */
export function listCharacters(): CharacterDef[] {
  return CHARACTERS;
}

/** Check if a character ID exists. */
export function hasCharacter(id: string): boolean {
  return charMap.has(id);
}

// Re-export types
export type { CharacterDef, CharacterAction, ActionDef, RenderRequest } from "./types";
