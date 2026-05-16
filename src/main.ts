import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

const appWindow = getCurrentWindow();

interface ImageData {
  name: string;
  path: string;
  orientation: 'landscape' | 'portrait';
  date_modified: number;
  size: number;
  width: number;
  height: number;
  thumbnail_path?: string | null;
}

interface FolderData {
  name: string;
  path: string;
  has_children?: boolean;
}

type SortOption = 'alphabetical' | 'date' | 'size' | 'resolution';
const PAGE_SIZE = 24;
const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 360;
const ROOT_FOLDERS_KEY = "root_folders";
const LEGACY_FOLDER_KEY = "last_folder";

let allImages: ImageData[] = [];
let rootFolders: string[] = [];
let currentFolder: string | null = null;
let userSid: string | null = null;
let currentFilter: 'all' | 'landscape' | 'portrait' = 'all';
let currentSort: SortOption = 'alphabetical';
let currentPage = 1;
let showAllImages = false;
let visibleImagesCache: ImageData[] = [];
let editingImagePath: string | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let folderRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let folderSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let isRefreshingFromWatcher = false;
let folderSearchQuery = "";
const expandedFolderPaths = new Set<string>();
const folderChildren = new Map<string, FolderData[]>();
const loadingFolderPaths = new Set<string>();
const folderLoadErrors = new Set<string>();

interface FolderChangedPayload {
  root_path: string;
}

const imageGrid = document.getElementById("image-grid");
const currentFolderPathEl = document.getElementById("current-folder-path");
const currentFolderNameEl = document.getElementById("current-folder-name");
const settingsSourceListEl = document.getElementById("settings-source-list");
const imageCountEl = document.getElementById("image-count");
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const folderSearchPanel = document.getElementById("folder-search-panel");
const folderSearchInput = document.getElementById("folder-search-input") as HTMLInputElement;
const settingsOverlay = document.getElementById("settings-overlay");
const pagePrevBtn = document.getElementById("page-prev") as HTMLButtonElement;
const pageNextBtn = document.getElementById("page-next") as HTMLButtonElement;
const seeAllBtn = document.getElementById("see-all-btn") as HTMLButtonElement;
const folderListEl = document.getElementById("folder-list");
const sidebarResizeHandle = document.getElementById("sidebar-resize-handle");

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return char;
    }
  });
}

function getBaseName(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, "");
}

function getFolderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function normalizeFolderKey(path: string) {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

function isSameFolder(a: string, b: string) {
  return normalizeFolderKey(a) === normalizeFolderKey(b);
}

function isPathInsideFolder(path: string, folder: string) {
  const normalizedPath = normalizeFolderKey(path);
  const normalizedFolder = normalizeFolderKey(folder);
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}\\`) || normalizedPath.startsWith(`${normalizedFolder}/`);
}

function getOwningRoot(path: string) {
  return rootFolders.find((root) => isPathInsideFolder(path, root)) || null;
}

function saveRootFolders() {
  localStorage.setItem(ROOT_FOLDERS_KEY, JSON.stringify(rootFolders));
}

function loadSavedRootFolders() {
  const savedRoots = localStorage.getItem(ROOT_FOLDERS_KEY);
  if (savedRoots) {
    try {
      const parsed = JSON.parse(savedRoots);
      if (Array.isArray(parsed)) {
        return parsed.filter((path): path is string => typeof path === "string" && path.trim().length > 0);
      }
    } catch {
      return [];
    }
  }

  const legacyFolder = localStorage.getItem(LEGACY_FOLDER_KEY);
  if (!legacyFolder) return [];

  localStorage.removeItem(LEGACY_FOLDER_KEY);
  localStorage.setItem(ROOT_FOLDERS_KEY, JSON.stringify([legacyFolder]));
  return [legacyFolder];
}

function dedupeRootFolders(paths: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  paths.forEach((path) => {
    const key = normalizeFolderKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(path);
  });

  return result;
}

function focusRenameInput(path: string) {
  window.setTimeout(() => {
    const input = imageGrid?.querySelector<HTMLInputElement>(`.rename-input[data-path="${CSS.escape(path)}"]`);
    input?.focus();
    input?.select();
  }, 0);
}

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function setSidebarWidth(width: number, persist = false) {
  const clampedWidth = clampSidebarWidth(width);
  document.documentElement.style.setProperty("--sidebar-width", `${clampedWidth}px`);

  if (persist) {
    localStorage.setItem("sidebar_width", String(clampedWidth));
  }
}

function initSidebarResize() {
  const savedWidth = Number(localStorage.getItem("sidebar_width"));
  if (Number.isFinite(savedWidth) && savedWidth > 0) {
    setSidebarWidth(savedWidth);
  }

  if (!sidebarResizeHandle) return;

  let isDragging = false;

  sidebarResizeHandle.addEventListener("pointerdown", (e) => {
    isDragging = true;
    sidebarResizeHandle.setPointerCapture(e.pointerId);
    document.body.classList.add("sidebar-resizing");
    setSidebarWidth(e.clientX);
  });

  sidebarResizeHandle.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    setSidebarWidth(e.clientX);
  });

  sidebarResizeHandle.addEventListener("pointerup", (e) => {
    if (!isDragging) return;
    isDragging = false;
    sidebarResizeHandle.releasePointerCapture(e.pointerId);
    document.body.classList.remove("sidebar-resizing");
    setSidebarWidth(e.clientX, true);
  });

  sidebarResizeHandle.addEventListener("pointercancel", () => {
    isDragging = false;
    document.body.classList.remove("sidebar-resizing");
  });

  sidebarResizeHandle.addEventListener("dblclick", () => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH, true);
  });
}

async function init() {
  loadUserSid();

  rootFolders = dedupeRootFolders(loadSavedRootFolders());
  saveRootFolders();

  if (rootFolders.length > 0) {
    currentFolder = rootFolders[0];
    updateFolderUI(currentFolder);
    renderFolderList();
    startFolderWatchers();
    rootFolders.forEach((root) => loadFolderChildren(root));
    loadImages(currentFolder);
  } else {
    showSelectFolderState();
    updateFolderUI(null);
  }
}

async function startFolderWatcher(path: string) {
  try {
    await invoke("watch_folder", { rootPath: path });
  } catch (error) {
    showToast("Automatic refresh unavailable.", "error");
  }
}

async function stopFolderWatcher(path: string) {
  try {
    await invoke("unwatch_folder", { rootPath: path });
  } catch {
    // The watcher is best effort. Removed roots are also ignored by the frontend event filter.
  }
}

function startFolderWatchers() {
  rootFolders.forEach((path) => startFolderWatcher(path));
}

async function initFolderChangeListener() {
  await listen<FolderChangedPayload>("folder-changed", (event) => {
    if (rootFolders.length === 0 || !currentFolder) return;
    if (!rootFolders.some((root) => isSameFolder(root, event.payload.root_path))) return;

    if (folderRefreshTimer) {
      clearTimeout(folderRefreshTimer);
    }

    folderRefreshTimer = setTimeout(async () => {
      if (isRefreshingFromWatcher) return;

      isRefreshingFromWatcher = true;
      try {
        await refreshCurrentFolder();
      } finally {
        isRefreshingFromWatcher = false;
      }
    }, 500);
  });
}

async function loadUserSid() {
  try {
    userSid = await invoke("get_user_sid");
  } catch (err) {
    showToast("System SID access restricted.", "error");
  }
}

function revealAppWindow() {
  window.requestAnimationFrame(() => {
    appWindow
      .show()
      .then(() => appWindow.setFocus())
      .catch(() => {});
  });
}

function updateFolderUI(path: string | null) {
  if (currentFolderPathEl) currentFolderPathEl.textContent = path || "Add a folder to view images";
  if (currentFolderNameEl) currentFolderNameEl.textContent = path ? getFolderName(path) : "No Folder Selected";
  renderSettingsSourceList();
}

function renderSettingsSourceList() {
  if (!settingsSourceListEl) return;

  settingsSourceListEl.innerHTML = "";
  if (rootFolders.length === 0) return;

  const fragment = document.createDocumentFragment();
  rootFolders.forEach((root) => {
    const row = document.createElement("div");
    row.className = "settings-source-row";

    const pathText = document.createElement("span");
    pathText.className = "settings-source-path";
    pathText.title = root;
    pathText.textContent = root;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "sidebar-icon-btn settings-source-remove";
    removeButton.title = "Remove source";
    removeButton.dataset.path = root;
    removeButton.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    `;

    row.appendChild(pathText);
    row.appendChild(removeButton);
    fragment.appendChild(row);
  });

  settingsSourceListEl.appendChild(fragment);
}

function renderFolderList() {
  if (!folderListEl) return;

  folderListEl.innerHTML = "";
  if (rootFolders.length === 0) {
    const placeholder = document.createElement("button");
    placeholder.type = "button";
    placeholder.className = "folder-control folder-item";
    placeholder.textContent = "No folder selected";
    placeholder.disabled = true;
    folderListEl.appendChild(placeholder);
    return;
  }

  const fragment = document.createDocumentFragment();
  let renderedCount = 0;

  rootFolders.forEach((root) => {
    const didRender = renderFolderBranch({
      name: getFolderName(root),
      path: root,
      has_children: (folderChildren.get(root)?.length || 0) > 0,
    }, 0, fragment, true);

    if (didRender) renderedCount += 1;
  });

  if (renderedCount === 0) {
    const emptyRow = document.createElement("div");
    emptyRow.className = "folder-tree-empty";
    emptyRow.textContent = "No matching folders";
    fragment.appendChild(emptyRow);
  }

  folderListEl.appendChild(fragment);
}

function folderMatchesSearch(folder: FolderData): boolean {
  if (!folderSearchQuery) return true;

  const query = folderSearchQuery.toLowerCase();
  if (folder.name.toLowerCase().includes(query)) return true;

  return (folderChildren.get(folder.path) || []).some((child) => folderMatchesSearch(child));
}

function renderFolderBranch(folder: FolderData, depth: number, container: DocumentFragment | HTMLElement, isRoot = false) {
  if (!folderMatchesSearch(folder)) return false;

  const isExpanded = expandedFolderPaths.has(folder.path);
  const isLoading = loadingFolderPaths.has(folder.path);
  const hasError = folderLoadErrors.has(folder.path);
  const canExpand = Boolean(folder.has_children) || isLoading;
  const row = document.createElement("div");
  row.className = `folder-tree-row ${currentFolder === folder.path ? "active" : ""} ${isRoot ? "root-row" : ""}`;
  row.style.setProperty("--folder-depth", String(depth));

  const folderButton = document.createElement("button");
  folderButton.type = "button";
  folderButton.className = "folder-control folder-item";
  folderButton.title = folder.path;
  folderButton.dataset.path = folder.path;

  const folderToggle = document.createElement("span");
  folderToggle.className = `folder-toggle ${isExpanded ? "expanded" : ""} ${canExpand ? "" : "empty"}`;
  folderToggle.title = canExpand ? (isExpanded ? "Collapse" : "Expand") : "";
  folderToggle.dataset.path = folder.path;
  folderToggle.innerHTML = canExpand ? `
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  ` : "";

  const folderIcon = document.createElement("span");
  folderIcon.className = "folder-icon";
  folderIcon.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.8l2 2.4H18a2.5 2.5 0 0 1 2.5 2.5v.6" />
      <path d="M3.5 8.5h17l-1.1 8.6a2.5 2.5 0 0 1-2.5 2.2H7.1a2.5 2.5 0 0 1-2.5-2.2L3.5 8.5Z" />
    </svg>
  `;

  const folderLabel = document.createElement("span");
  folderLabel.className = "folder-label";
  folderLabel.textContent = folder.name;

  folderButton.appendChild(folderToggle);
  folderButton.appendChild(folderIcon);
  folderButton.appendChild(folderLabel);

  row.appendChild(folderButton);
  container.appendChild(row);

  if (isExpanded || folderSearchQuery) {
    const children = folderChildren.get(folder.path) || [];
    children.forEach((child) => renderFolderBranch(child, depth + 1, container));

    if (!isLoading && hasError) {
      const emptyRow = document.createElement("div");
      emptyRow.className = "folder-tree-empty";
      emptyRow.style.setProperty("--folder-depth", String(depth + 1));
      emptyRow.textContent = "Could not load";
      container.appendChild(emptyRow);
    }
  }

  return true;
}

async function loadFolderChildren(path: string, force = false) {
  if (!force && (folderChildren.has(path) || loadingFolderPaths.has(path))) return;
  if (loadingFolderPaths.has(path)) return;

  if (force) {
    folderChildren.delete(path);
  }
  loadingFolderPaths.add(path);
  folderLoadErrors.delete(path);
  renderFolderList();

  try {
    const children = await invoke<FolderData[]>("list_subfolders", { rootPath: path });
    folderChildren.set(path, children);
  } catch (err) {
    folderChildren.set(path, []);
    folderLoadErrors.add(path);
  } finally {
    loadingFolderPaths.delete(path);
    renderFolderList();
  }
}

async function ensureFolderTreeLoaded(path: string, visited = new Set<string>()) {
  const key = normalizeFolderKey(path);
  if (visited.has(key)) return;

  visited.add(key);
  await loadFolderChildren(path);

  const children = folderChildren.get(path) || [];
  for (const child of children) {
    await ensureFolderTreeLoaded(child.path, visited);
  }
}

async function toggleFolder(path: string) {
  if (expandedFolderPaths.has(path)) {
    expandedFolderPaths.delete(path);
    renderFolderList();
    return;
  }

  expandedFolderPaths.add(path);
  renderFolderList();
  await loadFolderChildren(path);
}

function resetFolderTree() {
  expandedFolderPaths.clear();
  folderChildren.clear();
  loadingFolderPaths.clear();
  folderLoadErrors.clear();
}

function showSelectFolderState() {
  if (imageGrid) {
    imageGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-illustration">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        </div>
        <h2>Add Folder</h2>
        <p>Select a folder containing your lock screen images</p>
        <button class="btn-outline" onclick="document.getElementById('btn-settings').click()">Open Settings</button>
      </div>
    `;
  }
}

function showLoadingState() {
  if (imageGrid) {
    imageGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-illustration">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><path d="M3.3 7 12 12l8.7-5"></path><path d="M12 22V12"></path></svg>
        </div>
        <h2>Loading images</h2>
        <p>Preparing your gallery previews.</p>
      </div>
    `;
  }

  if (imageCountEl) {
    imageCountEl.textContent = "Loading...";
  }
}

async function selectFolder() {
  const selected = await open({
    directory: true,
    multiple: false,
  });

  if (selected && typeof selected === 'string') {
    if (!rootFolders.some((root) => isSameFolder(root, selected))) {
      rootFolders.push(selected);
      saveRootFolders();
    }

    currentFolder = selected;
    updateFolderUI(selected);
    await startFolderWatcher(selected);
    await loadFolderChildren(selected);
    renderFolderList();
    loadImages(selected);
    toggleSettings(false);
  }
}

async function removeRootFolder(path: string) {
  rootFolders = rootFolders.filter((root) => !isSameFolder(root, path));
  saveRootFolders();
  await stopFolderWatcher(path);

  for (const key of Array.from(folderChildren.keys())) {
    if (isPathInsideFolder(key, path)) folderChildren.delete(key);
  }
  for (const key of Array.from(expandedFolderPaths)) {
    if (isPathInsideFolder(key, path)) expandedFolderPaths.delete(key);
  }

  if (currentFolder && isPathInsideFolder(currentFolder, path)) {
    currentFolder = rootFolders[0] || null;
    if (currentFolder) {
      updateFolderUI(currentFolder);
      await loadFolderChildren(currentFolder);
      await loadImages(currentFolder);
    } else {
      allImages = [];
      resetPagination();
      updateFolderUI(null);
      renderFolderList();
      showSelectFolderState();
    }
    return;
  }

  updateFolderUI(currentFolder);
  renderFolderList();
}

async function loadImages(path: string) {
  try {
    currentFolder = path;
    updateFolderUI(path);
    renderFolderList();
    showLoadingState();
    allImages = await invoke("list_images", { dirPath: path });
    resetPagination();
    renderCurrentImages();
  } catch (err) {
    showToast("Could not load folder.", "error");
  }
}

async function refreshCurrentFolder() {
  if (rootFolders.length === 0 || !currentFolder) return;

  const expandedBeforeRefresh = new Set(expandedFolderPaths);
  resetFolderTree();
  expandedBeforeRefresh.forEach((path) => expandedFolderPaths.add(path));
  renderFolderList();

  for (const root of rootFolders) {
    await loadFolderChildren(root, true);
  }

  for (const path of expandedBeforeRefresh) {
    if (!rootFolders.some((root) => isSameFolder(root, path))) {
      await loadFolderChildren(path, true);
    }
  }

  if (folderSearchQuery) {
    for (const root of rootFolders) {
      await ensureFolderTreeLoaded(root);
    }
  }

  await loadImages(currentFolder);
}

function resetPagination() {
  currentPage = 1;
  showAllImages = false;
  editingImagePath = null;
}

function getVisibleImages() {
  return sortImages(filterImages());
}

function getPageImages(images: ImageData[]) {
  if (showAllImages) return images;

  const start = (currentPage - 1) * PAGE_SIZE;
  return images.slice(start, start + PAGE_SIZE);
}

function renderCurrentImages(recomputeVisibleImages = true) {
  if (recomputeVisibleImages) {
    visibleImagesCache = getVisibleImages();
  }

  const totalPages = Math.max(1, Math.ceil(visibleImagesCache.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  renderImages(getPageImages(visibleImagesCache));
  updatePaginationControls(visibleImagesCache.length, totalPages);
}

function updatePaginationControls(totalItems: number, totalPages: number) {
  const paginationAvailable = totalItems > PAGE_SIZE;

  if (pagePrevBtn) {
    pagePrevBtn.disabled = showAllImages || currentPage <= 1;
  }
  if (pageNextBtn) {
    pageNextBtn.disabled = showAllImages || currentPage >= totalPages || !paginationAvailable;
  }
  if (seeAllBtn) {
    seeAllBtn.disabled = !paginationAvailable;
    seeAllBtn.textContent = showAllImages ? "Show pages" : "See all";
    seeAllBtn.classList.toggle("active", paginationAvailable);
  }

  if (!imageCountEl) return;

  if (totalItems === 0) {
    imageCountEl.textContent = "0 items";
    return;
  }

  if (showAllImages || !paginationAvailable) {
    imageCountEl.textContent = `${totalItems} items`;
    return;
  }

  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, totalItems);
  imageCountEl.textContent = `${start}-${end} of ${totalItems} items`;
}

function renderImages(images: ImageData[]) {
  if (!imageGrid) return;

  if (images.length === 0) {
    imageGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-illustration">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
        </div>
        <h2>No items found</h2>
        <p>Try adjusting your search or filters.</p>
      </div>
    `;
    return;
  }

  imageGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();

  images.forEach((img) => {
    const previewPath = img.thumbnail_path || img.path;
    const assetUrl = convertFileSrc(previewPath);
    const originalAssetUrl = convertFileSrc(img.path);
    const displayName = getBaseName(img.name);
    const escapedName = escapeHtml(displayName);
    const orientationText = img.orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT';
    const isEditing = editingImagePath === img.path;

    const card = document.createElement("div");
    card.className = "image-card";
    card.dataset.path = img.path;

    card.innerHTML = `
      <div class="thumbnail-container">
        <img src="${assetUrl}" class="thumbnail" loading="lazy" data-original-src="${originalAssetUrl}" data-fallback-attempted="false" />
        <div class="apply-overlay">
          <button class="apply-btn-small" data-path="">Apply</button>
        </div>
      </div>
      <div class="card-info">
        <div class="card-title-row">
          ${isEditing ? `
            <input class="rename-input" type="text" value="${escapedName}" data-path="" />
          ` : `
            <div class="card-title-box">
              <span class="card-title" title="${escapedName}">${escapedName}</span>
              <button class="card-icon-btn rename-btn" type="button" title="Rename" data-path="">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
              </button>
              <button class="card-icon-btn delete-btn" type="button" title="Delete" data-path="">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
              </button>
            </div>
          `}
        </div>
        <div class="card-stats">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
          ${orientationText}
        </div>
      </div>
    `;

    const applyBtn = card.querySelector(".apply-btn-small");
    if (applyBtn instanceof HTMLElement) {
      applyBtn.dataset.path = img.path;
    }
    card.querySelectorAll<HTMLElement>(".rename-btn, .delete-btn").forEach((button) => {
      button.dataset.path = img.path;
    });
    const renameInput = card.querySelector<HTMLInputElement>(".rename-input");
    if (renameInput) {
      renameInput.dataset.path = img.path;
    }
    const thumbnail = card.querySelector<HTMLImageElement>(".thumbnail");
    if (thumbnail) {
      thumbnail.addEventListener("error", () => {
        const originalSrc = thumbnail.dataset.originalSrc;
        if (!originalSrc || thumbnail.dataset.fallbackAttempted === "true" || thumbnail.src === originalSrc) {
          return;
        }

        thumbnail.dataset.fallbackAttempted = "true";
        thumbnail.src = originalSrc;
      });
    }

    fragment.appendChild(card);
  });

  imageGrid.appendChild(fragment);
}

async function renameImage(path: string, newBaseName: string) {
  const owningRoot = getOwningRoot(path);
  if (!owningRoot) return;

  try {
    const renamedImage = await invoke<ImageData>("rename_image", {
      rootPath: owningRoot,
      imagePath: path,
      newBaseName,
    });

    allImages = allImages.map((img) => img.path === path ? renamedImage : img);
    editingImagePath = null;
    renderCurrentImages();
    showToast("Image renamed.", "success");
  } catch (error) {
    showToast(String(error), "error");
    editingImagePath = path;
    renderCurrentImages(false);
    focusRenameInput(path);
  }
}

async function deleteImage(path: string) {
  const owningRoot = getOwningRoot(path);
  if (!owningRoot) return;

  if (!window.confirm("Move this image to Recycle Bin?")) {
    return;
  }

  try {
    await invoke("delete_image", {
      rootPath: owningRoot,
      imagePath: path,
    });

    allImages = allImages.filter((img) => img.path !== path);
    renderCurrentImages();
    showToast("Image moved to Recycle Bin.", "success");
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function applyImage(path: string) {
  if (!userSid) {
    showToast("Administrator privileges required.", "error");
    return;
  }

  showToast("Updating lock screen...", "info");

  try {
    await invoke("apply_lock_screen", { imagePath: path, sid: userSid });
    showToast("Lock screen updated.", "success");
  } catch (error) {
    showToast("Permission error: " + error, "error");
  }
}

function filterImages() {
  const query = searchInput?.value.toLowerCase() || "";
  return allImages.filter(img => {
    const matchesQuery = img.name.toLowerCase().includes(query);
    const matchesFilter = currentFilter === 'all' || img.orientation === currentFilter;
    return matchesQuery && matchesFilter;
  });
}

function sortImages(images: ImageData[]) {
  return images.sort((a, b) => {
    switch (currentSort) {
      case 'alphabetical':
        return a.name.localeCompare(b.name);
      case 'date':
        return b.date_modified - a.date_modified;
      case 'size':
        return b.size - a.size;
      case 'resolution':
        return (b.width * b.height) - (a.width * a.height);
      default:
        return 0;
    }
  });
}

function showToast(message: string, type: "success" | "error" | "info" = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  container?.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 500);
  }, 4000);
}

function toggleSettings(show: boolean) {
  if (settingsOverlay) {
    if (show) {
      settingsOverlay.classList.add("active");
    } else {
      settingsOverlay.classList.remove("active");
    }
  }
}

function toggleFolderSearch(show: boolean) {
  folderSearchPanel?.classList.toggle("active", show);

  if (show) {
    folderSearchInput?.focus();
    folderSearchInput?.select();
  } else if (folderSearchInput) {
    folderSearchInput.value = "";
    folderSearchQuery = "";
    renderFolderList();
  }
}

async function updateFolderSearch(query: string) {
  folderSearchQuery = query.trim();

  if (folderSearchQuery) {
    for (const root of rootFolders) {
      await ensureFolderTreeLoaded(root);
    }
  }

  renderFolderList();
}

// Event Listeners
window.addEventListener("DOMContentLoaded", () => {
  initSidebarResize();
  initFolderChangeListener();
  revealAppWindow();
  init();

  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if (key === "escape" && settingsOverlay?.classList.contains("active")) {
      toggleSettings(false);
      return;
    }

    if (key === "f5" || ((e.ctrlKey || e.metaKey) && key === "r")) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // Titlebar
  document.getElementById('titlebar-minimize')?.addEventListener('click', () => appWindow.minimize());
  document.getElementById('titlebar-maximize')?.addEventListener('click', () => appWindow.toggleMaximize());
  document.getElementById('titlebar-close')?.addEventListener('click', () => appWindow.close());

  // Settings Actions
  document.getElementById('btn-settings')?.addEventListener('click', () => toggleSettings(true));
  document.getElementById('close-settings')?.addEventListener('click', () => toggleSettings(false));
  document.getElementById('select-folder-settings')?.addEventListener('click', selectFolder);
  document.getElementById('add-folder-sidebar')?.addEventListener('click', selectFolder);
  document.getElementById('folder-search-toggle')?.addEventListener('click', () => {
    toggleFolderSearch(!folderSearchPanel?.classList.contains("active"));
  });
  document.getElementById('folder-search-clear')?.addEventListener('click', () => toggleFolderSearch(false));

  settingsOverlay?.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) toggleSettings(false);
  });

  settingsSourceListEl?.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const removeButton = target.closest(".settings-source-remove");
    if (removeButton instanceof HTMLElement && removeButton.dataset.path) {
      removeRootFolder(removeButton.dataset.path);
    }
  });

  searchInput?.addEventListener("input", () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      resetPagination();
      renderCurrentImages();
    }, 200);
  });

  folderSearchInput?.addEventListener("input", () => {
    if (folderSearchDebounceTimer) clearTimeout(folderSearchDebounceTimer);
    folderSearchDebounceTimer = setTimeout(() => {
      updateFolderSearch(folderSearchInput.value);
    }, 200);
  });

  folderSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      toggleFolderSearch(false);
    }
  });

  imageGrid?.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const applyBtn = target.closest(".apply-btn-small");
    if (applyBtn instanceof HTMLElement && imageGrid.contains(applyBtn)) {
      const path = applyBtn.dataset.path;
      if (path) applyImage(path);
      return;
    }

    const renameBtn = target.closest(".rename-btn");
    if (renameBtn instanceof HTMLElement && imageGrid.contains(renameBtn)) {
      const path = renameBtn.dataset.path;
      if (!path) return;
      editingImagePath = path;
      renderCurrentImages(false);
      focusRenameInput(path);
      return;
    }

    const deleteBtn = target.closest(".delete-btn");
    if (deleteBtn instanceof HTMLElement && imageGrid.contains(deleteBtn)) {
      const path = deleteBtn.dataset.path;
      if (path) deleteImage(path);
    }
  });

  imageGrid?.addEventListener("keydown", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("rename-input")) return;

    if (e.key === "Enter") {
      e.preventDefault();
      const path = target.dataset.path;
      if (path) renameImage(path, target.value);
    }

    if (e.key === "Escape") {
      e.preventDefault();
      editingImagePath = null;
      renderCurrentImages(false);
    }
  });

  imageGrid?.addEventListener("focusout", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("rename-input")) return;

    window.setTimeout(() => {
      if (editingImagePath === target.dataset.path) {
        editingImagePath = null;
        renderCurrentImages(false);
      }
    }, 0);
  });

  folderListEl?.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const folderToggle = target.closest(".folder-toggle");
    if (folderToggle instanceof HTMLElement && folderToggle.dataset.path) {
      toggleFolder(folderToggle.dataset.path);
      return;
    }

    const folderButton = target.closest(".folder-item");
    if (folderButton instanceof HTMLElement && folderButton.dataset.path) {
      loadImages(folderButton.dataset.path);
    }
  });

  document.getElementById('refresh-btn')?.addEventListener('click', () => {
    refreshCurrentFolder();
  });

  pagePrevBtn?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage -= 1;
      renderCurrentImages(false);
    }
  });

  pageNextBtn?.addEventListener("click", () => {
    const totalPages = Math.ceil(visibleImagesCache.length / PAGE_SIZE);
    if (currentPage < totalPages) {
      currentPage += 1;
      renderCurrentImages(false);
    }
  });

  seeAllBtn?.addEventListener("click", () => {
    showAllImages = !showAllImages;
    currentPage = 1;
    renderCurrentImages(false);
  });

  // Pill active states (Sort and Type)
  document.querySelectorAll('.pill-group').forEach(group => {
    const pills = group.querySelectorAll('.pill');
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      });
    });
  });

  // Orientation Filter Actions
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.getAttribute('data-filter') as 'all' | 'landscape' | 'portrait';
      currentFilter = filter;
      resetPagination();
      renderCurrentImages();
    });
  });

  // Sort Actions
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sort = btn.getAttribute('data-sort') as SortOption;
      currentSort = sort;
      resetPagination();
      renderCurrentImages();
    });
  });
});
