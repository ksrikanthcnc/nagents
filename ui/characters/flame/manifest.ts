import type { CharacterDef } from "../types";
import svg from "./flame.svg?raw";

export const flame: CharacterDef = {
  id: "flame",
  name: "Flame",
  description: "Energetic living flame — flickers and dances",
  svg,
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 2000 },
    think: { cssClass: "char-slot-active", duration: 1000 },
    alert: { cssClass: "char-slot-alert", duration: 800 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    walk: { cssClass: "char-slot-idle", duration: 1500 },
    talk: { cssClass: "char-slot-active", duration: 1000 },
    wave: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
  customActions: {
    flare: { cssClass: "char-action-flare", duration: 1500 },
  },
};
