import type { CharacterDef } from "../types";
import svg from "./mushroom.svg?raw";

export const mushroom: CharacterDef = {
  id: "mushroom",
  name: "Mushroom",
  description: "Quirky forest friend — bounces and wobbles",
  svg,
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 3000 },
    think: { cssClass: "char-slot-active", duration: 2000 },
    alert: { cssClass: "char-slot-alert", duration: 1000 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2500, loop: false },
    walk: { cssClass: "char-slot-walk", duration: 800 },
    talk: { cssClass: "char-slot-active", duration: 2000 },
    wave: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
  customActions: {
    grow: { cssClass: "char-action-grow", duration: 2000 },
  },
};
