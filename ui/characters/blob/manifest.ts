import type { CharacterDef } from "../types";
import svg from "./blob.svg?raw";

export const blob: CharacterDef = {
  id: "blob",
  name: "Blob",
  description: "Friendly amorphous blob — squishes and pulses",
  svg,
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 3000 },
    think: { cssClass: "char-slot-active", duration: 2000 },
    alert: { cssClass: "char-slot-alert", duration: 1000 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    walk: { cssClass: "char-slot-idle", duration: 2500 },
    talk: { cssClass: "char-slot-active", duration: 1500 },
    wave: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
};
