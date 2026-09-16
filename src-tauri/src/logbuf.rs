//! In-memory log buffer — captures recent log lines for the /logs API.
//!
//! Works in both dev and prod mode. No file dependency.

use std::sync::Mutex;

const MAX_LINES: usize = 2000;

static LOG_BUFFER: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Push a log line to the buffer.
pub fn push(line: String) {
    if let Ok(mut buf) = LOG_BUFFER.lock() {
        buf.push(line);
        // Trim to keep memory bounded
        if buf.len() > MAX_LINES + 500 {
            let drain = buf.len() - MAX_LINES;
            buf.drain(..drain);
        }
    }
}

/// Get the last N lines from the buffer.
pub fn tail(n: usize) -> Vec<String> {
    if let Ok(buf) = LOG_BUFFER.lock() {
        let start = if buf.len() > n { buf.len() - n } else { 0 };
        buf[start..].to_vec()
    } else {
        vec![]
    }
}

/// Get total line count.
pub fn count() -> usize {
    LOG_BUFFER.lock().map(|b| b.len()).unwrap_or(0)
}

/// Custom env_logger formatter that also captures to buffer.
pub fn init_logger() {
    use std::io::Write;
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format(|buf, record| {
            let ts = buf.timestamp_millis();
            let line = format!(
                "[{} {:5} {}] {}",
                ts,
                record.level(),
                record.target(),
                record.args()
            );
            push(line.clone());
            writeln!(buf, "{}", line)
        })
        .init();
}
