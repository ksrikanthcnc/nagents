import type { CharacterDef } from "../types";
import svg from "./skeleton.svg?raw";

export const skeleton: CharacterDef = {
  id: "skeleton",
  name: "Skeleton",
  description: "Spooky skeleton pal — rattles when active",
  svg,
  defaultSource: "kiro-ide",
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 4000 },
    think: { cssClass: "char-slot-active", duration: 2000 },
    alert: { cssClass: "char-slot-alert", duration: 800 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    walk: { cssClass: "char-slot-walk", duration: 1000 },
    talk: { cssClass: "char-slot-active", duration: 2000 },
    wave: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
};
