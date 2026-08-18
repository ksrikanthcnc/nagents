# Character Contract

This document defines how to add a new character to nagents.

## Overview

A **character** is a visual representation of an agent session.
It appears in the panel and (when attention is needed) on the overlay.

Characters are self-contained plugins: SVG artwork + animation definitions.

## Creating a Character

### 1. Create the folder

```
ui/characters/<id>/
├── <id>.svg         — Character artwork (SVG, viewBox recommended: 56x56 to 56x72)
├── manifest.ts      — Implements CharacterDef interface
└── animations.css   — CSS keyframes for each action
```

### 2. Write the SVG

- Use a consistent viewBox (e.g., `viewBox="0 0 56 64"`)
- Keep it simple — these render at 28-40px in the panel
- Add class names to parts you want to animate (e.g., `class="eye"`)
- No external dependencies (no `<use>`, no linked images)

### 3. Implement manifest.ts

```typescript
import type { CharacterDef } from "../types";
import svg from "./<id>.svg?raw";

export const <id>: CharacterDef = {
  id: "<id>",
  name: "My Character",
  description: "A short description for the control center.",
  svg,
  defaultSource: "kiro-ide",  // optional: which source gets this by default
  actions: {
    idle: { cssClass: "<id>-idle", duration: 3000 },
    walk: { cssClass: "<id>-walk", duration: 600 },
    talk: { cssClass: "<id>-talk", duration: 400 },
    alert: { cssClass: "<id>-alert", duration: 1000 },
    sleep: { cssClass: "<id>-sleep", duration: 4000 },
    think: { cssClass: "<id>-think", duration: 2000 },
    celebrate: { cssClass: "<id>-celebrate", duration: 1500, loop: false },
    wave: { cssClass: "<id>-wave", duration: 800, loop: false },
    disappear: { cssClass: "<id>-disappear", duration: 500, loop: false },
  },
};
```

### 4. Write animations.css

```css
@keyframes <id>-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}
.<id>-idle {
  animation: <id>-bob 3s ease-in-out infinite;
}

/* ... define keyframes for each action ... */
```

### 5. Register in registry.ts

```typescript
import { myChar } from "./<id>/manifest";

// Add to CHARACTERS array:
const CHARACTERS: CharacterDef[] = [ghost, cat, myChar];
```

### 6. Import CSS in entry files

In both `ui/main.ts` and `ui/overlay-entry.ts`:
```typescript
import "./characters/<id>/animations.css";
```

## Standard Actions

| Action | When triggered | Expected behavior |
|--------|---------------|-------------------|
| `idle` | Default state | Gentle ambient motion (bob, sway, breathe) |
| `walk` | Moving toward target | Bouncy/energetic movement |
| `talk` | Speech bubble visible | Mouth/body squish |
| `alert` | Needs attention | Jump, glow, pulse — eye-catching |
| `sleep` | Session inactive long | Slow drift, faded, small |
| `think` | Tool running / working | Wobble, spin, focused |
| `celebrate` | Task completed | Big movement, plays once |
| `wave` | Appearing / greeting | Quick gesture, plays once |
| `disappear` | Leaving overlay | Fade + shrink, plays once |

Characters can implement any subset. Missing actions = character stays in current state.

## Custom Actions

Beyond the standard set, characters can define custom actions:

```typescript
customActions: {
  "shout": { cssClass: "<id>-shout", duration: 500, loop: false },
  "dance": { cssClass: "<id>-dance", duration: 2000 },
}
```

Custom actions are triggered programmatically and are fully optional.

## Design Tips

- Keep SVGs simple (small file size = fast rendering of many instances)
- Use CSS transforms for animation (GPU-accelerated)
- Add `randomOffset: true` to idle for natural staggering between instances
- Test at 28px (panel) and 40px (overlay) sizes
- Characters with distinct silhouettes work best at small sizes
