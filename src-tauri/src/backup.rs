//! State backup & restore.
//!
//! Backs up the durable state (data/ dir + config.local.yaml) into a single
//! portable .zip, and restores it back. Platform-generic — paths come from the
//! app data root (app_data_dir in prod, project root in dev), which is already
//! resolved per-OS by lib.rs.
//!
//! Backup layout inside the zip (flat, rooted):
//!   data/sessions.json
//!   data/events/*.jsonl
//!   config.local.yaml
//!
//! Restore extracts these back over the data root, overwriting.

use log::{info, warn};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

/// Relative paths (under the data root) that make up a state backup.
/// Everything else in the data root (caches, logs) is intentionally excluded.
const BACKUP_ROOTS: &[&str] = &["data", "config.local.yaml"];

/// Create a zip backup of the state at `data_root` into `dest_zip`.
pub fn backup_state(data_root: &Path, dest_zip: &Path) -> Result<usize, String> {
    let file = fs::File::create(dest_zip)
        .map_err(|e| format!("create {}: {}", dest_zip.display(), e))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut count = 0usize;
    for root in BACKUP_ROOTS {
        let abs = data_root.join(root);
        if !abs.exists() {
            continue;
        }
        if abs.is_dir() {
            count += add_dir_to_zip(&mut zip, data_root, &abs, &opts)?;
        } else {
            add_file_to_zip(&mut zip, data_root, &abs, &opts)?;
            count += 1;
        }
    }

    zip.finish().map_err(|e| format!("finalize zip: {}", e))?;
    info!("[backup] wrote {} files to {}", count, dest_zip.display());
    Ok(count)
}

/// Restore a zip backup from `src_zip` into `data_root`, overwriting existing
/// state files. Returns the number of entries restored.
///
/// Guards against zip-slip: entries whose resolved path escapes `data_root`
/// are skipped.
pub fn restore_state(src_zip: &Path, data_root: &Path) -> Result<usize, String> {
    let file = fs::File::open(src_zip)
        .map_err(|e| format!("open {}: {}", src_zip.display(), e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("read zip: {}", e))?;

    let root_canon = data_root
        .canonicalize()
        .unwrap_or_else(|_| data_root.to_path_buf());

    let mut count = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip entry {}: {}", i, e))?;
        let name = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => {
                warn!("[restore] skipping unsafe entry: {}", entry.name());
                continue;
            }
        };
        let out_path = data_root.join(&name);

        // zip-slip guard: ensure the destination stays under data_root.
        let parent = out_path.parent().unwrap_or(data_root);
        let _ = fs::create_dir_all(parent);
        let check = parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf());
        if !check.starts_with(&root_canon) {
            warn!("[restore] skipping path outside data root: {}", out_path.display());
            continue;
        }

        if entry.is_dir() {
            let _ = fs::create_dir_all(&out_path);
            continue;
        }

        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(|e| format!("read entry {}: {}", name.display(), e))?;
        let mut out = fs::File::create(&out_path)
            .map_err(|e| format!("write {}: {}", out_path.display(), e))?;
        out.write_all(&buf).map_err(|e| format!("write {}: {}", out_path.display(), e))?;
        count += 1;
    }

    info!("[restore] restored {} files from {}", count, src_zip.display());
    Ok(count)
}

/// Recursively add a directory's files to the zip, keyed by path relative to
/// `data_root`.
fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    data_root: &Path,
    dir: &Path,
    opts: &zip::write::FileOptions<'_, ()>,
) -> Result<usize, String> {
    let mut count = 0usize;
    let entries = fs::read_dir(dir).map_err(|e| format!("read dir {}: {}", dir.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            count += add_dir_to_zip(zip, data_root, &path, opts)?;
        } else {
            add_file_to_zip(zip, data_root, &path, opts)?;
            count += 1;
        }
    }
    Ok(count)
}

/// Add a single file to the zip under its path relative to `data_root`.
fn add_file_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    data_root: &Path,
    file: &Path,
    opts: &zip::write::FileOptions<'_, ()>,
) -> Result<(), String> {
    let rel = file.strip_prefix(data_root).unwrap_or(file);
    // zip paths use forward slashes on all platforms.
    let name = rel.to_string_lossy().replace('\\', "/");
    zip.start_file(name, *opts).map_err(|e| format!("zip start_file: {}", e))?;
    let data = fs::read(file).map_err(|e| format!("read {}: {}", file.display(), e))?;
    zip.write_all(&data).map_err(|e| format!("zip write: {}", e))?;
    Ok(())
}

/// Default backup filename with a timestamp: nagents-backup-<epoch>.zip
pub fn default_backup_name() -> String {
    let secs = crate::state::now_epoch() as u64;
    format!("nagents-backup-{}.zip", secs)
}
