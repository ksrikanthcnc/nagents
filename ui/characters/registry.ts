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
