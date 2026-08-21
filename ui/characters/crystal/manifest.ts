import type { CharacterDef } from "../types";
import svg from "./crystal.svg?raw";

export const crystal: CharacterDef = {
  id: "crystal",
  name: "Crystal",
  description: "Geometric and precise — sparkles and refracts",
  svg,
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 4000 },
    think: { cssClass: "char-slot-active", duration: 2000 },
    alert: { cssClass: "char-slot-alert", duration: 800 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2500, loop: false },
    walk: { cssClass: "char-slot-walk", duration: 2500 },
    talk: { cssClass: "char-slot-active", duration: 2000 },
    wave: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
};
