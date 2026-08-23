//! Platform-specific cursor position reading.
//!
//! Each platform has its own implementation behind #[cfg] gates.
//! Linux stub returns (0,0) — needs xdotool or /proc/bus/input adapter.

/// Get global cursor position (screen coordinates).
#[cfg(target_os = "macos")]
pub fn get_cursor_position() -> (f64, f64) {
    use std::ffi::c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const c_void) -> *const c_void;
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
        fn CFRelease(cf: *const c_void);
    }
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return (0.0, 0.0);
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        (point.x, point.y)
    }
}

#[cfg(target_os = "windows")]
pub fn get_cursor_position() -> (f64, f64) {
    use std::mem::MaybeUninit;
    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn GetCursorPos(point: *mut POINT) -> i32;
    }
    unsafe {
        let mut point = MaybeUninit::<POINT>::uninit();
        if GetCursorPos(point.as_mut_ptr()) != 0 {
            let p = point.assume_init();
            (p.x as f64, p.y as f64)
        } else {
            (0.0, 0.0)
        }
    }
}

/// Linux: TODO — needs xdotool, X11 XQueryPointer, or Wayland protocol.
/// For now returns (0, 0). Overlay cursor poll will return this until implemented.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn get_cursor_position() -> (f64, f64) {
    // Attempt xdotool as fallback
    if let Ok(output) = std::process::Command::new("xdotool")
        .args(["getmouselocation", "--shell"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut x = 0.0;
        let mut y = 0.0;
        for line in stdout.lines() {
            if let Some(val) = line.strip_prefix("X=") {
                x = val.parse().unwrap_or(0.0);
            } else if let Some(val) = line.strip_prefix("Y=") {
                y = val.parse().unwrap_or(0.0);
            }
        }
        (x, y)
    } else {
        (0.0, 0.0)
    }
}
