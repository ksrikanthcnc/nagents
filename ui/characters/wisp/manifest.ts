import type { CharacterDef } from "../types";
import svg from "./wisp.svg?raw";

export const wisp: CharacterDef = {
  id: "wisp",
  name: "Wisp",
  description: "A floating eye with a trailing glow — investigates and watches",
  svg,
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 3000, randomOffset: true, randomOffsetMax: 2 },
    think: { cssClass: "char-slot-active", duration: 1500 },
    alert: { cssClass: "char-slot-alert", duration: 1000 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    walk: { cssClass: "char-slot-walk", duration: 2000 },
    talk: { cssClass: "char-slot-active", duration: 1500 },
    wave: { cssClass: "char-slot-celebrate", duration: 1000, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 3000, loop: false },
  },
};
