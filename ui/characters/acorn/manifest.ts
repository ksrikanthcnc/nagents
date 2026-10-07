import type { CharacterDef } from "../types";
import svg from "./acorn.svg?raw";

export const acorn: CharacterDef = {
  id: "acorn",
  name: "Acorn",
  description: "Cute acorn with a woody cap — rolls and bounces",
  svg,
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 3000 },
    think: { cssClass: "char-slot-active", duration: 2000 },
    alert: { cssClass: "char-slot-alert", duration: 1000 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    walk: { cssClass: "char-slot-walk", duration: 1500 },
    talk: { cssClass: "char-slot-active", duration: 1500 },
    wave: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
};
