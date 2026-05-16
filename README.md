# LSChanger

Windows Tauri 2 app to browse local wallpaper folders and apply image as Windows lock screen. Stack: Tauri 2, TypeScript, Vite, Rust.

## Current State

- One selected root folder plus direct child folders only. No recursive scan.
- Root sidebar label is **Default**. Do not rename back to `Root`.
- Supported discovery extensions: `.jpg`, `.jpeg`, `.png`, `.webp`.
- Decode uses content sniffing, so PNG bytes named `.jpg` can still work.
- Right-click WebView/browser context menu disabled globally.
- User prefers no automated tests unless explicitly requested.
- User prefers to run full Tauri build manually. Do not run `npm run tauri build` unless asked.

## Features

- Select image folder in Settings.
- Browse Default folder and direct subfolders.
- Filter: `All`, `Landscape`, `Portrait`.
- Sort: alphabetical, date, size, resolution.
- Pagination: 24/page, previous/next, **See all**.
- Refresh current folder via header refresh icon.
- Hover card thumbnail, click **Apply**.
- Rename image, preserving extension.
- Delete image to Windows Recycle Bin.

## Runtime Data

Data lives beside running executable:

```text
LSChanger_Data\
  EBWebView\
  cache\
    image-metadata.json
    thumbnails\
```

- `EBWebView` is WebView runtime data. Never store LSChanger cache there.
- LSChanger cache belongs in `LSChanger_Data\cache`.
- `image-metadata.json` stores path, size, modified time, dimensions, orientation, thumbnail path.
- `thumbnails\` stores generated preview JPGs.
- Cache key uses normalized path + modified timestamp + file size.
- Cache is disposable. Refresh/load folder rebuilds missing cache.
- Cached `width == 0` or `height == 0` is invalid and rebuilt.
- Missing thumbnails regenerate.
- Broken thumbnail load falls back to original image once.

Example paths:

```text
D:\LSChanger\lschanger.exe
D:\LSChanger\LSChanger_Data
```

```text
D:\changeLockScreen\src-tauri\target\release\lschanger.exe
D:\changeLockScreen\src-tauri\target\release\LSChanger_Data
```

## Lock Screen Apply

Apply flow:

- Grants Windows permissions on lock-screen locations when needed.
- Decodes selected image using content sniffing.
- Writes real JPEG to:

```text
C:\Windows\Web\Screen\img100.jpg
```

- Clears Windows readonly lock-screen cache folders when present.
- If source decode fails, apply fails instead of writing bad bytes.
- Admin may be needed if Windows blocks permission changes.

## Commands

```bash
npm install
npm run build
cd src-tauri
cargo check
```

Run dev:

```bash
npm run tauri dev
```

Build exe only when user asks:

```bash
npm run tauri build
```

Exe output:

```text
src-tauri\target\release\lschanger.exe
```

Installer bundling disabled in `src-tauri\tauri.conf.json`.

## Build Profile

Current fast iteration profile in `src-tauri\Cargo.toml`:

```toml
[profile.release]
lto = "thin"
codegen-units = 16
strip = true
```

Final optimized exe profile:

```toml
[profile.release]
lto = true
codegen-units = 1
strip = true
```

Switch back only before final release build.

## Manual Checks

- Open image folder.
- Confirm root label **Default**.
- Refresh folder.
- Switch subfolders.
- Search/filter/sort.
- Page prev/next and **See all**.
- Rename image.
- Delete image.
- Delete `LSChanger_Data\cache\thumbnails`, refresh, thumbnails recover or fallback.
- Delete `LSChanger_Data\cache\image-metadata.json`, refresh, metadata rebuilds.
- Apply normal JPG.
- Apply PNG-content file with `.jpg` extension.
- Right-click should not open WebView context menu.

## Recent Context

- Thumbnail + metadata cache implemented.
- Zero-dimension metadata invalidated.
- Missing thumbnails regenerate.
- Broken thumbnails fallback to original once.
- Apply re-encodes selected image as JPEG.
- Refresh icon added left of page arrows.
- Apply button styled like selected sidebar button.
