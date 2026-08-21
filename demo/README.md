# nagents demo

Standalone web demo of the nagents overlay — no Tauri/Rust needed.

## What it does

- Shows the overlay with animated characters
- Control panel (bottom-right) lets you:
  - Add sessions (source + group:title)
  - Change state (working → done → approval → stuck)
  - Randomize (spawn N sessions with random states)
  - Auto lifecycle (watch a session go through all phases)
  - Adjust config (followers, roamers, dots, sorting mode)

## Development

```bash
cd demo/
npx vite          # serve locally
```

## Deploy (GitHub Pages)

```bash
npx vite build    # builds to demo/dist/
# Push demo/dist/ to gh-pages branch
```

## TODO

- [ ] Import actual overlay physics from ../ui/overlay/
- [ ] Render real character SVGs
- [ ] Full mode assignment from modes.ts
- [ ] Cursor tracking (mouse position as "cursor")
- [ ] Connection lines between same-group chars
