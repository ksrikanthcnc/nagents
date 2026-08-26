/**
 * Character System Tests
 *
 * Verifies the character registry works correctly:
 * - All 13 characters registered and accessible
 * - Unknown ID falls back to ghost
 * - Each character has required fields (id, name, svg, actions)
 * - hasCharacter lookup works
 */

import { describe, it, expect } from "vitest";
import { getCharacter, listCharacters, hasCharacter } from "../ui/characters/registry";

const EXPECTED_CHARS = [
  "ghost", "cat", "skeleton", "robot", "owl",
  "mushroom", "flame", "crystal", "cloud", "blob",
  "wisp", "spark", "orb",
];

describe("Character Registry", () => {
  it("all 13 characters registered", () => {
    const chars = listCharacters();
    expect(chars).toHaveLength(13);
  });

  it("all expected character IDs present", () => {
    for (const id of EXPECTED_CHARS) {
      expect(hasCharacter(id)).toBe(true);
    }
  });

  it("getCharacter returns correct character by ID", () => {
    const ghost = getCharacter("ghost");
    expect(ghost.id).toBe("ghost");

    const cat = getCharacter("cat");
    expect(cat.id).toBe("cat");

    const orb = getCharacter("orb");
    expect(orb.id).toBe("orb");
  });

  it("unknown ID falls back to ghost", () => {
    const result = getCharacter("nonexistent");
    expect(result.id).toBe("ghost");

    const result2 = getCharacter("");
    expect(result2.id).toBe("ghost");

    const result3 = getCharacter("unicorn-dragon-9000");
    expect(result3.id).toBe("ghost");
  });

  it("hasCharacter returns false for unknown IDs", () => {
    expect(hasCharacter("nonexistent")).toBe(false);
    expect(hasCharacter("")).toBe(false);
    expect(hasCharacter("Ghost")).toBe(false); // case-sensitive
  });

  it("every character has required fields", () => {
    const chars = listCharacters();
    for (const char of chars) {
      expect(char.id).toBeTruthy();
      expect(char.name).toBeTruthy();
      expect(char.svg).toBeTruthy();
      expect(char.actions).toBeDefined();
      expect(typeof char.actions).toBe("object");
    }
  });

  it("every character has at least idle action", () => {
    const chars = listCharacters();
    for (const char of chars) {
      expect(char.actions.idle).toBeDefined();
      expect(char.actions.idle!.cssClass).toBeTruthy();
    }
  });

  it("character SVG contains valid SVG markup", () => {
    const chars = listCharacters();
    for (const char of chars) {
      expect(char.svg).toContain("<svg");
      expect(char.svg).toContain("</svg>");
    }
  });

  it("character IDs are unique", () => {
    const chars = listCharacters();
    const ids = chars.map(c => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("action cssClass follows naming convention", () => {
    const chars = listCharacters();
    for (const char of chars) {
      for (const [actionName, actionDef] of Object.entries(char.actions)) {
        if (actionDef) {
          // Should be non-empty class name
          expect(actionDef.cssClass).toBeTruthy();
          expect(typeof actionDef.cssClass).toBe("string");
        }
      }
    }
  });
});
