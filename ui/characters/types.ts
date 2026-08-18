/**
 * Character Plugin Interface.
 *
 * To add a new character:
 *   1. Create a folder: ui/characters/<id>/
 *   2. Add manifest.ts implementing CharacterDef
 *   3. Add <id>.svg (the character artwork)
 *   4. Add animations.css (keyframes for each action)
 *   5. Register in registry.ts
 *
 * Characters are self-contained. The system tells them WHAT state they're in
 * (via actions). The character defines HOW it looks in each state.
 */

// ─── Actions ────────────────────────────────────────────────────────────────

/**
 * Standard actions the system can trigger on any character.
 * Characters implement whichever subset they want.
 * Missing action = graceful no-op (character just stays in current state).
 */
export type CharacterAction =
  | "idle"       // Default ambient animation (always on when nothing else)
  | "walk"       // Moving toward cursor / target
  | "talk"       // Speech bubble visible, character is "speaking"
  | "alert"      // Needs user attention (pulsing, jumping, glowing)
  | "sleep"      // Deep idle (session inactive for a long time)
  | "celebrate"  // Task completed successfully
  | "think"      // Processing / working (tool running)
  | "wave"       // Greeting / appearing
  | "disappear"; // Fading out / leaving overlay

/**
 * Action definition — how a character responds to a behavioral state.
 * Renderer-agnostic: fields are hints that the rendering layer interprets.
 */
export interface ActionDef {
  /** CSS class applied to the character container. */
  cssClass: string;
  /** Duration hint in ms (for animations). */
  duration?: number;
  /** Whether to randomize animation-delay per instance (e.g., blink offsets). */
  randomOffset?: boolean;
  /** Max random offset in seconds (default: 3). */
  randomOffsetMax?: number;
  /** Whether this action loops or plays once. Default: true (loop). */
  loop?: boolean;
}

// ─── Character Definition ───────────────────────────────────────────────────

/**
 * Full character definition — everything needed to render and animate.
 *
 * This is THE interface for the character plugin system.
 * Anyone can implement this to add a new character.
 */
export interface CharacterDef {
  /** Unique identifier (e.g., "ghost", "cat"). Used in config + state. */
  id: string;
  /** Display name (e.g., "Ghost", "Cat"). */
  name: string;
  /** Short description for the control center. */
  description: string;
  /** Raw SVG string (loaded via ?raw import in Vite). */
  svg: string;
  /** Default source association (for auto-assignment in config). */
  defaultSource?: string;

  /**
   * Action implementations.
   * Map of action name → how this character performs it.
   * Only implement what makes sense for your character.
   */
  actions: Partial<Record<CharacterAction, ActionDef>>;

  /**
   * Custom actions beyond the standard set.
   * Other plugins/sources can trigger these by name.
   * If character doesn't define them, nothing happens.
   */
  customActions?: Record<string, ActionDef>;
}

// ─── Render Request ─────────────────────────────────────────────────────────

/**
 * What the panel/overlay asks the character system to render.
 * Decouples state logic from rendering.
 */
export interface RenderRequest {
  /** Which character to render. */
  characterId: string;
  /** Current action to display. */
  action: CharacterAction;
  /** Size in pixels. */
  size: number;
  /** Optional label text (session name). */
  label?: string;
  /** Source (for color theming). */
  source?: string;
}
