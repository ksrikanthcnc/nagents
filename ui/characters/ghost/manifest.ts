import type { CharacterDef } from "../types";
import svg from "./ghost.svg?raw";

export const ghost: CharacterDef = {
  id: "ghost",
  name: "Ghost",
  description: "Friendly floating ghost. Default for crew sessions.",
  svg,
  defaultSource: "crew",
  actions: {
    idle: {
      cssClass: "ghost-idle",
      duration: 3000,
      randomOffset: true,
      randomOffsetMax: 2,
    },
    walk: {
      cssClass: "ghost-walk",
      duration: 600,
    },
    talk: {
      cssClass: "ghost-talk",
      duration: 400,
    },
    alert: {
      cssClass: "ghost-alert",
      duration: 1000,
    },
    sleep: {
      cssClass: "ghost-sleep",
      duration: 4000,
    },
    think: {
      cssClass: "ghost-think",
      duration: 2000,
    },
    celebrate: {
      cssClass: "ghost-celebrate",
      duration: 1500,
      loop: false,
    },
    wave: {
      cssClass: "ghost-wave",
      duration: 800,
      loop: false,
    },
    disappear: {
      cssClass: "ghost-disappear",
      duration: 500,
      loop: false,
    },
  },
};
