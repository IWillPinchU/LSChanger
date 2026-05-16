use std::collections::{HashMap, HashSet};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use image::codecs::jpeg::JpegEncoder;
use image::io::Reader as ImageReader;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
pub struct ImageData {
    name: String,
    path: String,
    orientation: String,
    date_modified: u64,
    size: u64,
    width: u32,
    height: u32,
    thumbnail_path: Option<String>,
}

#[derive(Serialize)]
pub struct FolderData {
    name: String,
    path: String,
    has_children: bool,
}

#[derive(Clone, Serialize)]
struct FolderChangedPayload {
    root_path: String,
}

#[derive(Serialize)]
struct ImportSummary {
    imported: usize,
    skipped: usize,
    overwritten: usize,
    renamed: usize,
}

struct FolderWatcherState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(Clone, Deserialize, Serialize)]
struct CachedImageData {
    path: String,
    date_modified: u64,
    size: u64,
    width: u32,
    height: u32,
    orientation: String,
    thumbnail_path: Option<String>,
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
}

type MetadataCache = HashMap<String, CachedImageData>;

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .map(|ext| {
            let ext = ext.to_string_lossy().to_lowercase();
            ext == "jpg" || ext == "jpeg" || ext == "png" || ext == "webp"
        })
        .unwrap_or(false)
}

fn file_modified_secs(metadata: &fs::Metadata) -> u64 {
    metadata.modified()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(std::time::Duration::from_secs(0))
        .as_secs()
}

fn cache_root() -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok()?;
    Some(exe_path.parent()?.join("LSChanger_Data").join("cache"))
}

fn metadata_cache_path() -> Option<PathBuf> {
    Some(cache_root()?.join("image-metadata.json"))
}

fn thumbnails_dir() -> Option<PathBuf> {
    Some(cache_root()?.join("thumbnails"))
}

fn load_metadata_cache() -> MetadataCache {
    let Some(cache_path) = metadata_cache_path() else {
        return HashMap::new();
    };

    let Ok(content) = fs::read_to_string(cache_path) else {
        return HashMap::new();
    };

    serde_json::from_str(&content).unwrap_or_default()
}

fn save_metadata_cache(cache: &MetadataCache) {
    let Some(cache_path) = metadata_cache_path() else {
        return;
    };
    let Some(cache_dir) = cache_path.parent() else {
        return;
    };

    if fs::create_dir_all(cache_dir).is_err() {
        return;
    }

    if let Ok(content) = serde_json::to_string_pretty(cache) {
        let _ = fs::write(cache_path, content);
    }
}

fn thumbnail_file_name(path: &str, date_modified: u64, size: u64) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    date_modified.hash(&mut hasher);
    size.hash(&mut hasher);
    format!("{:016x}-{}-{}.jpg", hasher.finish(), date_modified, size)
}

fn generate_thumbnail(source: &Path, target: &Path) -> Option<()> {
    if target.exists() {
        return Some(());
    }

    fs::create_dir_all(target.parent()?).ok()?;

    let image = ImageReader::open(source).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let thumbnail = image.thumbnail(480, 270).to_rgb8();
    let file = fs::File::create(target).ok()?;
    let mut encoder = JpegEncoder::new_with_quality(file, 78);
    encoder.encode_image(&thumbnail).ok()?;
    Some(())
}

fn image_dimensions(path: &Path) -> (u32, u32) {
    ImageReader::open(path)
        .ok()
        .and_then(|reader| reader.with_guessed_format().ok())
        .and_then(|reader| reader.into_dimensions().ok())
        .unwrap_or((0, 0))
}

fn write_jpeg_image(source: &Path, target: &Path) -> Result<(), String> {
    let image = ImageReader::open(source)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    let rgb_image = image.to_rgb8();
    let file = fs::File::create(target).map_err(|e| e.to_string())?;
    let mut encoder = JpegEncoder::new_with_quality(file, 92);
    encoder.encode_image(&rgb_image).map_err(|e| e.to_string())
}

fn thumbnail_path_for_image(path: &Path, normalized_path: &str, date_modified: u64, size: u64) -> Option<String> {
    let thumbnails = thumbnails_dir()?;
    let target = thumbnails.join(thumbnail_file_name(normalized_path, date_modified, size));
    generate_thumbnail(path, &target)?;
    Some(normalize_path_string(&target))
}

fn valid_cached_thumbnail_path(path: Option<&String>) -> Option<String> {
    let thumbnail_path = path?;
    if Path::new(thumbnail_path).is_file() {
        Some(thumbnail_path.clone())
    } else {
        None
    }
}

fn is_valid_cached_metadata(entry: &CachedImageData, date_modified: u64, size: u64) -> bool {
    entry.date_modified == date_modified && entry.size == size && entry.width > 0 && entry.height > 0
}

fn image_data_from_path_with_cache(path: PathBuf, cache: &MetadataCache) -> Option<(ImageData, CachedImageData)> {
    let metadata = fs::metadata(&path).ok()?;
    let size = metadata.len();
    let date_modified = file_modified_secs(&metadata);
    let normalized_path = normalize_path_string(&path);

    let cached = cache
        .get(&normalized_path)
        .filter(|entry| is_valid_cached_metadata(entry, date_modified, size));

    let (width, height, orientation, thumbnail_path) = if let Some(entry) = cached {
        (
            entry.width,
            entry.height,
            entry.orientation.clone(),
            valid_cached_thumbnail_path(entry.thumbnail_path.as_ref())
                .or_else(|| thumbnail_path_for_image(&path, &normalized_path, date_modified, size)),
        )
    } else {
        let (width, height) = image_dimensions(&path);
        let orientation = if height > width { "portrait" } else { "landscape" }.to_string();
        let thumbnail_path = thumbnail_path_for_image(&path, &normalized_path, date_modified, size);
        (width, height, orientation, thumbnail_path)
    };

    let image_data = ImageData {
        name: path.file_name()?.to_string_lossy().to_string(),
        path: normalized_path.clone(),
        orientation: orientation.clone(),
        date_modified,
        size,
        width,
        height,
        thumbnail_path: thumbnail_path.clone(),
    };

    let cached_data = CachedImageData {
        path: normalized_path,
        date_modified,
        size,
        width,
        height,
        orientation,
        thumbnail_path,
    };

    Some((image_data, cached_data))
}

fn image_data_from_path(path: PathBuf) -> Option<ImageData> {
    image_data_from_path_with_cache(path, &HashMap::new()).map(|(image_data, _)| image_data)
}

fn remove_cached_image(path: &str) {
    let mut cache = load_metadata_cache();
    if let Some(entry) = cache.remove(path) {
        if let Some(thumbnail_path) = entry.thumbnail_path {
            let _ = fs::remove_file(thumbnail_path);
        }
        save_metadata_cache(&cache);
    }
}

fn cleanup_thumbnail_dir(valid_thumbnail_paths: &HashSet<String>) {
    let Some(thumbnails) = thumbnails_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(thumbnails) else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let normalized = normalize_path_string(&path);
        if !valid_thumbnail_paths.contains(&normalized) {
            let _ = fs::remove_file(path);
        }
    }
}

fn canonical_root(root_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root_path).map_err(|e| e.to_string())?;
    if root.is_dir() {
        Ok(root)
    } else {
        Err("Root folder is not a directory.".to_string())
    }
}

fn canonical_file_under_root(root_path: &str, image_path: &str) -> Result<PathBuf, String> {
    let root = canonical_root(root_path)?;
    let image = fs::canonicalize(image_path).map_err(|e| e.to_string())?;

    if !image.starts_with(&root) || !image.is_file() || !is_supported_image(&image) {
        return Err("Image is outside selected folder.".to_string());
    }

    Ok(image)
}

fn has_invalid_filename_chars(name: &str) -> bool {
    name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
}

fn normalize_path_string(path: &Path) -> String {
    let path_string = path.to_string_lossy();

    if let Some(rest) = path_string.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = path_string.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path_string.to_string()
    }
}

fn unique_import_target(target: PathBuf) -> PathBuf {
    if !target.exists() {
        return target;
    }

    let parent = target
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(PathBuf::new);
    let stem = target
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    let extension = target
        .extension()
        .map(|value| value.to_string_lossy().to_string());

    for index in 1.. {
        let file_name = match &extension {
            Some(extension) => format!("{} ({}).{}", stem, index, extension),
            None => format!("{} ({})", stem, index),
        };
        let candidate = parent.join(file_name);

        if !candidate.exists() {
            return candidate;
        }
    }

    target
}

fn folder_has_children(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .any(|entry| entry.path().is_dir())
        })
        .unwrap_or(false)
}

#[tauri::command]
fn get_user_sid() -> Result<String, String> {
    let output = hidden_command("whoami")
        .arg("/user")
        .arg("/fo")
        .arg("csv")
        .arg("/nh")
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = stdout.trim().split(',').collect();
    if parts.len() >= 2 {
        Ok(parts[1].trim_matches('"').to_string())
    } else {
        Err("Failed to parse SID from whoami output".to_string())
    }
}

#[tauri::command]
fn grant_permissions(path: String) -> Result<(), String> {
    let status = hidden_command("takeown")
        .arg("/f")
        .arg(&path)
        .arg("/r")
        .arg("/d")
        .arg("y")
        .status()
        .map_err(|e| e.to_string())?;

    if !status.success() {
        return Err(format!("takeown failed for {}", path));
    }

    let status = hidden_command("icacls")
        .arg(&path)
        .arg("/grant")
        .arg("*S-1-5-32-544:F")
        .arg("/t")
        .status()
        .map_err(|e| e.to_string())?;

    if !status.success() {
        return Err(format!("icacls failed for {}", path));
    }

    Ok(())
}

#[tauri::command]
fn list_images(dir_path: String) -> Result<Vec<ImageData>, String> {
    let entries = fs::read_dir(dir_path).map_err(|e| e.to_string())?;
    let paths: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_supported_image(path))
        .collect();

    let cache = load_metadata_cache();
    let results: Vec<_> = paths
        .into_par_iter()
        .filter_map(|path| image_data_from_path_with_cache(path, &cache))
        .collect();

    let mut images = Vec::with_capacity(results.len());
    let mut updated_cache = cache.clone();

    for (image_data, cached_data) in results {
        updated_cache.insert(cached_data.path.clone(), cached_data);
        images.push(image_data);
    }

    updated_cache.retain(|_, entry| Path::new(&entry.path).is_file());

    let valid_thumbnail_paths: HashSet<String> = updated_cache
        .values()
        .filter_map(|entry| entry.thumbnail_path.clone())
        .collect();

    save_metadata_cache(&updated_cache);
    cleanup_thumbnail_dir(&valid_thumbnail_paths);

    Ok(images)
}

#[tauri::command]
fn import_images(
    target_folder: String,
    source_paths: Vec<String>,
    duplicate_mode: String,
) -> Result<ImportSummary, String> {
    if duplicate_mode != "overwrite" && duplicate_mode != "rename" {
        return Err("Invalid duplicate handling mode.".to_string());
    }

    let target_root = fs::canonicalize(target_folder).map_err(|e| e.to_string())?;
    if !target_root.is_dir() {
        return Err("Import target is not a folder.".to_string());
    }

    let mut summary = ImportSummary {
        imported: 0,
        skipped: 0,
        overwritten: 0,
        renamed: 0,
    };

    for source_path in source_paths {
        let Ok(source) = fs::canonicalize(source_path) else {
            summary.skipped += 1;
            continue;
        };

        if !source.is_file() || !is_supported_image(&source) {
            summary.skipped += 1;
            continue;
        }

        let Some(file_name) = source.file_name() else {
            summary.skipped += 1;
            continue;
        };

        let initial_target = target_root.join(file_name);
        let mut did_rename = false;
        let mut did_overwrite = false;

        let target = if initial_target.exists() && duplicate_mode == "rename" {
            let renamed_target = unique_import_target(initial_target);
            if renamed_target.exists() {
                summary.skipped += 1;
                continue;
            }
            did_rename = true;
            renamed_target
        } else {
            if initial_target.exists() {
                let same_file = fs::canonicalize(&initial_target)
                    .map(|target| target == source)
                    .unwrap_or(false);

                if same_file {
                    summary.skipped += 1;
                    continue;
                }

                if duplicate_mode == "overwrite" {
                    did_overwrite = true;
                }
            }

            initial_target
        };

        match fs::copy(&source, &target) {
            Ok(_) => {
                summary.imported += 1;
                if did_rename {
                    summary.renamed += 1;
                }
                if did_overwrite {
                    summary.overwritten += 1;
                }
            }
            Err(_) => summary.skipped += 1,
        }
    }

    Ok(summary)
}

#[tauri::command]
fn list_subfolders(root_path: String) -> Result<Vec<FolderData>, String> {
    let root = canonical_root(&root_path)?;
    let mut folders: Vec<FolderData> = fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let has_children = folder_has_children(&path);
            Some(FolderData {
                name: path.file_name()?.to_string_lossy().to_string(),
                path: normalize_path_string(&path),
                has_children,
            })
        })
        .collect();

    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(folders)
}

#[tauri::command]
fn watch_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, FolderWatcherState>,
    root_path: String,
) -> Result<(), String> {
    let root = canonical_root(&root_path)?;
    let payload_root = normalize_path_string(&root);
    let event_root = payload_root.clone();
    let app_handle = app.clone();

    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if result.is_ok() {
            let _ = app_handle.emit(
                "folder-changed",
                FolderChangedPayload {
                    root_path: event_root.clone(),
                },
            );
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut active_watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    active_watchers.insert(payload_root, watcher);

    Ok(())
}

#[tauri::command]
fn unwatch_folder(
    state: tauri::State<'_, FolderWatcherState>,
    root_path: String,
) -> Result<(), String> {
    let root = canonical_root(&root_path)?;
    let payload_root = normalize_path_string(&root);
    let mut active_watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    active_watchers.remove(&payload_root);
    Ok(())
}

#[tauri::command]
fn rename_image(root_path: String, image_path: String, new_base_name: String) -> Result<ImageData, String> {
    let image = canonical_file_under_root(&root_path, &image_path)?;
    let trimmed_name = new_base_name.trim();

    if trimmed_name.is_empty() || trimmed_name == "." || trimmed_name == ".." || has_invalid_filename_chars(trimmed_name) {
        return Err("Invalid file name.".to_string());
    }

    let extension = image.extension()
        .ok_or_else(|| "Image has no extension.".to_string())?
        .to_string_lossy()
        .to_string();
    let parent = image.parent().ok_or_else(|| "Image has no parent folder.".to_string())?;
    let target = parent.join(format!("{}.{}", trimmed_name, extension));

    if target.exists() {
        return Err("File already exists.".to_string());
    }

    let old_path = normalize_path_string(&image);
    fs::rename(&image, &target).map_err(|e| e.to_string())?;
    remove_cached_image(&old_path);
    image_data_from_path(target).ok_or_else(|| "Could not read renamed image.".to_string())
}

#[tauri::command]
fn delete_image(root_path: String, image_path: String) -> Result<(), String> {
    let image = canonical_file_under_root(&root_path, &image_path)?;
    let cached_path = normalize_path_string(&image);
    trash::delete(&image).map_err(|e| e.to_string())?;
    remove_cached_image(&cached_path);
    Ok(())
}

#[tauri::command]
fn apply_lock_screen(image_path: String, sid: String) -> Result<(), String> {
    let system_web_screen = "C:\\Windows\\Web\\Screen";
    let system_data_root = format!("C:\\ProgramData\\Microsoft\\Windows\\SystemData\\{}", sid);
    let system_data_readonly = format!("C:\\ProgramData\\Microsoft\\Windows\\SystemData\\{}\\ReadOnly", sid);

    if Path::new(&system_data_root).exists() {
        let _ = grant_permissions(system_data_root.clone());
    }
    
    let _ = grant_permissions(system_web_screen.to_string());
    
    if Path::new(&system_data_readonly).exists() {
        let _ = grant_permissions(system_data_readonly.clone());
    }

    let dest_web = Path::new(system_web_screen).join("img100.jpg");
    write_jpeg_image(Path::new(&image_path), &dest_web)?;

    if Path::new(&system_data_readonly).exists() {
        let entries = fs::read_dir(&system_data_readonly).map_err(|e| e.to_string())?;
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_dir() {
                    let _ = fs::remove_dir_all(path);
                } else {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn get_setting(key: String) -> Result<Option<String>, String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe_path.parent().unwrap();
    let settings_path = dir.join("settings.ini");

    if !settings_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(settings_path).map_err(|e| e.to_string())?;
    for line in content.lines() {
        if line.starts_with(&format!("{}=", key)) {
            let value = line.trim_start_matches(&format!("{}=", key)).to_string();
            return Ok(Some(value));
        }
    }
    Ok(None)
}

#[tauri::command]
fn save_setting(key: String, value: String) -> Result<(), String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe_path.parent().unwrap();
    let settings_path = dir.join("settings.ini");

    let mut new_lines = Vec::new();
    let mut found = false;

    if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        for line in content.lines() {
            if line.starts_with(&format!("{}=", key)) {
                new_lines.push(format!("{}={}", key, value));
                found = true;
            } else {
                new_lines.push(line.to_string());
            }
        }
    }

    if !found {
        new_lines.push(format!("{}={}", key, value));
    }

    fs::write(settings_path, new_lines.join("\n")).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(FolderWatcherState {
            watchers: Mutex::new(HashMap::new()),
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_user_sid,
            grant_permissions,
            list_images,
            import_images,
            list_subfolders,
            watch_folder,
            unwatch_folder,
            rename_image,
            delete_image,
            apply_lock_screen,
            get_setting,
            save_setting
        ])
        .setup(|app| {
            let exe_path = std::env::current_exe().unwrap();
            let exe_dir = exe_path.parent().unwrap();
            let data_dir = exe_dir.join("LSChanger_Data");

            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("LSChanger")
                .inner_size(1000.0, 700.0)
                .decorations(false)
                .visible(false)
                .data_directory(data_dir)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
