import type { CharacterDef } from "../types";
import svg from "./orb.svg?raw";

export const orb: CharacterDef = {
  id: "orb",
  name: "Orb",
  description: "Analytical scanning orb — rotates and pulses with data",
  svg,
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 4000 },
    think: { cssClass: "char-slot-active", duration: 2000 },
    alert: { cssClass: "char-slot-alert", duration: 1000 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    walk: { cssClass: "char-slot-walk", duration: 3000 },
    talk: { cssClass: "char-slot-active", duration: 2000 },
    wave: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 3000, loop: false },
  },
};
