/**
 * Settings UI — auto-generated from config-schema.ts.
 * Single source of truth: schema defines types, bounds, options, descriptions.
 */

import { getConfig, log, onConfigChanged } from "../shared/bridge";
import { CONFIG_SCHEMA, getSection, getSections, clampValue, type SettingDef } from "../shared/config-schema";
import type { OverlayConfig } from "../shared/types";

let container: HTMLElement | null = null;
let cfg: OverlayConfig | null = null;

export async function initSettings(el: HTMLElement): Promise<void> {
  container = el;

  const config = await getConfig();
  cfg = config.overlay;
  render();

  onConfigChanged((fresh) => {
    if (fresh.overlay) {
      cfg = fresh.overlay;
      // Don't re-render if user is actively editing (would lose focus)
      // Only update on external changes
    }
  });
}

function render(): void {
  if (!container || !cfg) return;
  const ov = cfg as any;
  const mode = ov.overlay_mode || "full";

  // Mode selector
  let html = `<h1>nagents settings</h1>`;
  html += `<div class="mode-selector">`;
  const modeOpts = CONFIG_SCHEMA.find(s => s.key === "overlay_mode")?.options || [];
  for (const opt of modeOpts) {
    html += `<button class="mode-btn ${mode === opt.value ? "active" : ""}" data-mode="${opt.value}">${opt.label}</button>`;
  }
  html += `</div>`;

  // Sections (skip "mode" since it's the selector above)
  for (const section of getSections()) {
    if (section === "mode") continue;
    const defs = getSection(section);
    if (defs.length === 0) continue;

    html += `<h2>${section}</h2>`;
    html += `<div class="settings-section">`;
    for (const def of defs) {
      html += renderField(def, ov);
    }
    html += `</div>`;
  }

  container.innerHTML = html;
  attachHandlers();
}

function renderField(def: SettingDef, ov: any): string {
  const value = ov[def.key] ?? def.default;

  if (def.type === "select" && def.options) {
    let opts = "";
    for (const opt of def.options) {
      const selected = String(value) === opt.value ? "selected" : "";
      opts += `<option value="${opt.value}" ${selected}>${opt.label}</option>`;
    }
    return `<label title="${def.description}">${def.label}<select class="cfg-input" data-key="${def.key}">${opts}</select></label>`;
  }

  if (def.type === "number") {
    const attrs = [
      `type="number"`,
      `class="cfg-input"`,
      `data-key="${def.key}"`,
      `value="${value}"`,
      def.min !== undefined ? `min="${def.min}"` : "",
      def.max !== undefined ? `max="${def.max}"` : "",
      def.step !== undefined ? `step="${def.step}"` : "",
    ].filter(Boolean).join(" ");
    return `<label title="${def.description}">${def.label}<input ${attrs}></label>`;
  }

  // Fallback: text input
  return `<label title="${def.description}">${def.label}<input type="text" class="cfg-input" data-key="${def.key}" value="${value}"></label>`;
}

function attachHandlers(): void {
  if (!container) return;

  // Mode selector — special: also sets battery_saver for "off" mode
  container.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode!;
      // "off" = battery saver on (shows BSB, hides overlay)
      if (mode === "off") {
        localStorage.setItem("nagents:battery_saver", "true");
      } else {
        localStorage.removeItem("nagents:battery_saver");
      }
      fetch("http://127.0.0.1:3335/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overlay: { overlay_mode: mode } }),
      }).catch(() => {});
      log("settings", `mode → ${mode}`);
      container!.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  // All cfg-input elements — POST to config immediately
  // Flow: UI change → POST /config → Rust writes config.local.yaml → fs watch → config-changed event → all windows reload cfg
  container.querySelectorAll(".cfg-input").forEach((el) => {
    el.addEventListener("change", () => {
      const key = (el as HTMLElement).dataset.key!;
      let value: string | number | boolean = (el as HTMLInputElement | HTMLSelectElement).value;
      const def = CONFIG_SCHEMA.find(s => s.key === key);
      // Clamp numbers
      if (def?.type === "number") {
        value = clampValue(key, parseFloat(value as string));
        (el as HTMLInputElement).value = String(value);
      }
      // Parse booleans
      if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (def?.type === "number") value = parseFloat(String(value));

      fetch("http://127.0.0.1:3335/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overlay: { [key]: value } }),
      }).catch(() => {});
      log("settings", `${key} → ${value}`);
    });
  });
}
