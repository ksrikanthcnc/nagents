//! Power source monitoring — detects AC/battery and Low Power Mode.
//!
//! Platform implementations:
//!   macOS  — `pmset -g batt` for battery, `pmset -g` for Low Power Mode
//!   Windows — TODO: WMI Win32_Battery / GetSystemPowerStatus
//!   Linux  — TODO: /sys/class/power_supply/
//!
//! Polls every 15s and emits `nagents:power-changed` Tauri event on transitions.
//! Used by the overlay to auto-switch between full mode and BSB.

use log::info;
use serde::Serialize;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PowerState {
    /// True when running on battery (not plugged in).
    pub on_battery: bool,
    /// Battery percentage (0-100), if available.
    pub battery_level: Option<f64>,
    /// True when plugged in and charging.
    pub is_charging: bool,
    /// True when OS-level low power / battery saver mode is active.
    /// macOS: Low Power Mode. Windows: Battery Saver. Linux: TLP/power-profiles.
    pub low_power_mode: bool,
}

// ─── macOS ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn get_power_state() -> PowerState {
    use std::process::Command;

    // Battery state from `pmset -g batt`
    // Output: "Now drawing from 'AC Power'" or "Now drawing from 'Battery Power'"
    let batt_output = Command::new("pmset").args(["-g", "batt"]).output();
    let (on_battery, battery_level, is_charging) = match batt_output {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            let on_battery = text.contains("Battery Power");
            let is_charging = text.contains("charging") && !text.contains("not charging");
            let level = text.lines()
                .find(|l| l.contains("InternalBattery"))
                .and_then(|line| {
                    line.split_whitespace()
                        .find(|w| w.ends_with("%;") || w.ends_with('%'))
                        .and_then(|w| w.trim_end_matches("%;").trim_end_matches('%').parse::<f64>().ok())
                });
            (on_battery, level, is_charging)
        }
        Err(_) => (false, None, false),
    };

    // Low Power Mode from `pmset -g`
    // When active: "lowpowermode 1"
    let low_power_mode = Command::new("pmset").args(["-g"]).output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("lowpowermode         1"))
        .unwrap_or(false);

    PowerState { on_battery, battery_level, is_charging, low_power_mode }
}

// ─── Windows ────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn get_power_state() -> PowerState {
    use std::process::Command;
    // Use WMIC for battery status (works on all Windows versions)
    // wmic path Win32_Battery get BatteryStatus,EstimatedChargeRemaining
    let output = Command::new("wmic")
        .args(["path", "Win32_Battery", "get", "BatteryStatus,EstimatedChargeRemaining", "/format:csv"])
        .output();

    match output {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            // Parse CSV: Node,BatteryStatus,EstimatedChargeRemaining
            // BatteryStatus: 1=discharging, 2=AC, 3-5=charging variants
            let mut on_battery = false;
            let mut battery_level = None;
            let mut is_charging = false;
            for line in text.lines().skip(1) {
                let fields: Vec<&str> = line.split(',').collect();
                if fields.len() >= 3 {
                    let status: u32 = fields[1].trim().parse().unwrap_or(0);
                    let level: f64 = fields[2].trim().parse().unwrap_or(0.0);
                    on_battery = status == 1;
                    is_charging = status >= 3;
                    battery_level = Some(level);
                }
            }
            // Windows Battery Saver: check via powercfg
            let low_power = Command::new("powercfg").args(["/getactivescheme"]).output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("Power saver"))
                .unwrap_or(false);
            PowerState { on_battery, battery_level, is_charging, low_power_mode: low_power }
        }
        Err(_) => PowerState { on_battery: false, battery_level: None, is_charging: false, low_power_mode: false },
    }
}

// ─── Linux ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn get_power_state() -> PowerState {
    // Read /sys/class/power_supply/BAT0/status and capacity
    let status = std::fs::read_to_string("/sys/class/power_supply/BAT0/status")
        .unwrap_or_default();
    let capacity = std::fs::read_to_string("/sys/class/power_supply/BAT0/capacity")
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok());
    let on_battery = status.trim() == "Discharging";
    let is_charging = status.trim() == "Charging";
    // Linux low power: check power-profiles-daemon or TLP
    let low_power = std::process::Command::new("powerprofilesctl").arg("get").output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "power-saver")
        .unwrap_or(false);
    PowerState { on_battery, battery_level: capacity, is_charging, low_power_mode: low_power }
}

// ─── Fallback (other platforms) ─────────────────────────────────────────────

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn get_power_state() -> PowerState {
    PowerState { on_battery: false, battery_level: None, is_charging: false, low_power_mode: false }
}

// ─── Tauri Commands ─────────────────────────────────────────────────────────

/// Get current power state (for initial check on overlay start).
#[tauri::command]
pub fn get_power() -> PowerState {
    get_power_state()
}

// ─── Monitoring Loop ────────────────────────────────────────────────────────

/// Start power monitoring loop.
/// Sets runtime overrides on ConfigHandle when power state changes.
/// The frontend gets the effective config via GET /config (which includes runtime overrides).
pub fn start_monitoring(app: AppHandle, config: crate::config::ConfigHandle) {
    thread::spawn(move || {
        let mut prev = get_power_state();
        info!("[power] monitoring started (on_battery={}, low_power={})", prev.on_battery, prev.low_power_mode);

        // Set initial runtime state
        apply_power_runtime(&config, &prev, Some(&app));

        loop {
            thread::sleep(Duration::from_secs(15));
            let state = get_power_state();
            // Always re-apply: handles config changes (e.g. user toggling
            // auto_battery_mode off) even when the power state itself didn't
            // change. Cheap — just reads config + sets one runtime key.
            apply_power_runtime(&config, &state, Some(&app));
            if state.on_battery != prev.on_battery || state.low_power_mode != prev.low_power_mode {
                info!("[power] changed: on_battery={} low_power={} level={:?} charging={}",
                    state.on_battery, state.low_power_mode, state.battery_level, state.is_charging);
                let _ = app.emit("nagents:power-changed", &state);
            }
            prev = state;
        }
    });
}

/// Apply power state as runtime config overrides.
/// If auto_battery_mode is on and we're on battery/low power → override to BSB mode.
/// If on AC → clear runtime overrides (user config takes effect).
fn apply_power_runtime(config: &crate::config::ConfigHandle, state: &PowerState, app: Option<&AppHandle>) {
    let user_cfg = config.get();
    let auto_mode = user_cfg.overlay.extra.get("auto_battery_mode")
        .and_then(|v| match v {
            serde_json::Value::Bool(b) => Some(*b),
            serde_json::Value::String(s) => Some(s != "false"),
            _ => None,
        })
        .unwrap_or(true);

    if !auto_mode {
        // Auto battery disabled: don't touch battery_saver. The user's manual
        // setting (via tray/settings/runtime API) should persist.
        return;
    }

    let should_bsb = state.on_battery || state.low_power_mode;
    config.set_runtime("battery_saver", serde_json::Value::Bool(should_bsb), app);
    if should_bsb {
        info!("[power] runtime: battery_saver=true (auto)");
    } else {
        info!("[power] runtime: battery_saver=false (AC, auto)");
    }
}
