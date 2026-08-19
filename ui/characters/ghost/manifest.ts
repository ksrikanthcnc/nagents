import type { CharacterDef } from "../types";
import svg from "./ghost.svg?raw";

export const ghost: CharacterDef = {
  id: "ghost",
  name: "Ghost",
  description: "Classic friendly ghost — floats and blinks",
  svg,
  defaultSource: "kiro-crew",
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 3000, randomOffset: true, randomOffsetMax: 3 },
    think: { cssClass: "char-slot-active", duration: 3000 },
    alert: { cssClass: "char-slot-alert", duration: 1000 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    talk: { cssClass: "char-slot-speak" },
    walk: { cssClass: "char-slot-walk", duration: 1200 },
    wave: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
};
