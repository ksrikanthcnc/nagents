import type { CharacterDef } from "../types";
import svg from "./spark.svg?raw";

export const spark: CharacterDef = {
  id: "spark",
  name: "Spark",
  description: "Tiny energetic worker — buzzes and flashes",
  svg,
  actions: {
    idle: { cssClass: "char-slot-idle", duration: 2000 },
    think: { cssClass: "char-slot-active", duration: 1000 },
    alert: { cssClass: "char-slot-alert", duration: 800 },
    sleep: { cssClass: "char-slot-sleep" },
    celebrate: { cssClass: "char-slot-celebrate", duration: 1500, loop: false },
    walk: { cssClass: "char-slot-walk", duration: 600 },
    talk: { cssClass: "char-slot-active", duration: 1000 },
    wave: { cssClass: "char-slot-celebrate", duration: 1000, loop: false },
    disappear: { cssClass: "char-slot-fading", duration: 2000, loop: false },
  },
};
