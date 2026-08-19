import type { CharacterDef } from "../types";
import svg from "./robot.svg?raw";

export const robot: CharacterDef = {
  id: "robot",
  name: "Robot",
  description: "Helpful robot companion — pulses when active",
  svg,
  defaultSource: "kiro-ide",
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 2000 },
    think: { cssClass: "char-slot-active", duration: 1500 },
    alert: { cssClass: "char-slot-alert", duration: 1000 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    walk: { cssClass: "char-slot-idle", duration: 2000 },
    talk: { cssClass: "char-slot-active", duration: 1500 },
    wave: { cssClass: "char-slot-celebrate", duration: 2000, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 5000, loop: false },
  },
  customActions: {
    scan: { cssClass: "char-action-scan", duration: 3000 },
  },
};
