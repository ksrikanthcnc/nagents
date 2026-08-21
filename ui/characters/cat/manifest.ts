import type { CharacterDef } from "../types";
import svg from "./cat.svg?raw";

export const cat: CharacterDef = {
  id: "cat",
  name: "Cat",
  description: "Mysterious black cat with green eyes — sways gently",
  svg,
  defaultSource: "kiro-cli",
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 2500, randomOffset: true, randomOffsetMax: 2 },
    think: { cssClass: "char-slot-active", duration: 3000 },
    alert: { cssClass: "char-slot-alert", duration: 1000 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    talk: { cssClass: "char-slot-active", duration: 2000 },
    walk: { cssClass: "char-slot-walk", duration: 500 },
    wave: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
};
