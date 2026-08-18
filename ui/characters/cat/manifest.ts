import type { CharacterDef } from "../types";
import svg from "./cat.svg?raw";

export const cat: CharacterDef = {
  id: "cat",
  name: "Cat",
  description: "Curious cat with glowing eyes. Default for CLI sessions.",
  svg,
  defaultSource: "kiro-cli",
  actions: {
    idle: {
      cssClass: "cat-idle",
      duration: 2500,
      randomOffset: true,
      randomOffsetMax: 2,
    },
    walk: {
      cssClass: "cat-walk",
      duration: 500,
    },
    talk: {
      cssClass: "cat-talk",
      duration: 300,
    },
    alert: {
      cssClass: "cat-alert",
      duration: 800,
    },
    sleep: {
      cssClass: "cat-sleep",
      duration: 5000,
    },
    think: {
      cssClass: "cat-think",
      duration: 1500,
    },
    celebrate: {
      cssClass: "cat-celebrate",
      duration: 1200,
      loop: false,
    },
    wave: {
      cssClass: "cat-wave",
      duration: 600,
      loop: false,
    },
    disappear: {
      cssClass: "cat-disappear",
      duration: 500,
      loop: false,
    },
  },
};
