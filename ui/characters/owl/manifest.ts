import type { CharacterDef } from "../types";
import svg from "./owl.svg?raw";

export const owl: CharacterDef = {
  id: "owl",
  name: "Owl",
  description: "Wise nocturnal companion — blinks slowly, head rotates",
  svg,
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 4000, randomOffset: true, randomOffsetMax: 3 },
    think: { cssClass: "char-slot-active", duration: 2000 },
    alert: { cssClass: "char-slot-alert", duration: 1000 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    walk: { cssClass: "char-slot-idle", duration: 3000 },
    talk: { cssClass: "char-slot-active", duration: 2000 },
    wave: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
};
