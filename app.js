// ==========================================
// INDEXEDDB ENGINE
// ==========================================
const DB_NAME = 'CodeCombinerDB';
const DB_VERSION = 1;
let dbInstance = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };
    req.onerror = (e) => reject(e);
  });
}

async function dbSaveAllFiles(filesMap) {
  const db = await openDatabase();
  const tx = db.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  await new Promise((res, rej) => {
    const clearReq = store.clear();
    clearReq.onsuccess = res;
    clearReq.onerror = rej;
  });
  for (const [path, data] of filesMap.entries()) {
    store.put({ path, ...data });
  }
  return new Promise((res) => { tx.oncomplete = res; });
}

async function dbLoadAllFiles() {
  const db = await openDatabase();
  const tx = db.transaction('files', 'readonly');
  const store = tx.objectStore('files');
  return new Promise((resolve) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function dbSaveSetting(key, val) {
  const db = await openDatabase();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key, val });
}

async function dbLoadSetting(key, defaultVal) {
  const db = await openDatabase();
  const tx = db.transaction('settings', 'readonly');
  return new Promise((resolve) => {
    const req = tx.objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.val : defaultVal);
    req.onerror = () => resolve(defaultVal);
  });
}

// ==========================================
// CORE STATE & CONFIG
// ==========================================
const MAX_FILE_SIZE_BYTES = 12 * 1024 * 1024;
const loadedFiles = new Map(); // path => { content, lines, chars, included }

// Standard anime/samurai duel wallpaper (Miyamoto Musashi duel at Ganryu-jima)
const DEFAULT_WALLPAPER = 'https://upload.wikimedia.org/wikipedia/commons/b/b5/Miyamoto-Musashi-Fights-Sasaki-Kojiro-at-Ganryujima-Ukiyo-e.png';

const DEFAULT_IGNORED_FOLDERS = new Set([
  '.git', '.github', 'node_modules', 'dist', 'build',
  '.next', '.nuxt', 'out', '.cache', '.vscode', '.idea', '__pycache__'
]);

const DEFAULT_IGNORED_FILES = new Set([
  '.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'
]);

let customIgnorePatterns = [];
let savedPrePrompts = [
  { id: '1', title: 'Talk Before Code', content: 'Please review the attached code and error logs. Talk to me first, explaining your analysis and proposal before writing any code.' },
  { id: '2', title: 'Find Bug & Fix', content: 'Analyze the error log and relevant files below. Identify the exact root cause and provide the minimal fix required.' },
  { id: '3', title: 'Refactor Review', content: 'Review the architecture and patterns in these files. Suggest clean, idiomatic improvements without breaking existing behavior.' }
];

let activePromptId = null;
let includeAsciiTree = true;
let collapsedFolders = new Set();
let currentWallpaper = DEFAULT_WALLPAPER;
let currentOpacity = 0.45;

// DOM Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const selectFilesTrigger = document.getElementById('select-files-trigger');
const selectFolderTrigger = document.getElementById('select-folder-trigger');
const selectLogTrigger = document.getElementById('select-log-trigger');

const fileTreeEl = document.getElementById('file-tree');
const searchFilter = document.getElementById('search-filter');
const toggleAllBtn = document.getElementById('toggle-all-btn');
const collapseAllBtn = document.getElementById('collapse-all-btn');
const includeTreeToggle = document.getElementById('include-tree-toggle');
const outputPreview = document.getElementById('output-preview');
const previewArtwork = document.getElementById('preview-artwork');

const totalFilesEl = document.getElementById('total-files');
const totalLinesEl = document.getElementById('total-lines');
const totalSizeEl = document.getElementById('total-size');
const totalTokensEl = document.getElementById('total-tokens');

const copyBtn = document.getElementById('copy-btn');
const clearBtn = document.getElementById('clear-btn');
const downloadTxtBtn = document.getElementById('download-txt-btn');
const downloadMdBtn = document.getElementById('download-md-btn');

// Modals
const pasteModal = document.getElementById('paste-modal');
const openPasteModalBtn = document.getElementById('open-paste-modal-btn');
const pasteModalClose = document.getElementById('paste-modal-close');
const pasteModalCancel = document.getElementById('paste-modal-cancel');
const pasteModalSubmit = document.getElementById('paste-modal-submit');
const logNameInput = document.getElementById('log-name-input');
const logContentInput = document.getElementById('log-content-input');

const ignoreModal = document.getElementById('ignore-modal');
const openIgnoreModalBtn = document.getElementById('open-ignore-modal-btn');
const ignoreModalClose = document.getElementById('ignore-modal-close');
const ignoreModalCancel = document.getElementById('ignore-modal-cancel');
const ignoreModalSave = document.getElementById('ignore-modal-save');
const ignorePatternsInput = document.getElementById('ignore-patterns-input');

const wallpaperModal = document.getElementById('wallpaper-modal');
const openWallpaperModalBtn = document.getElementById('open-wallpaper-modal-btn');
const wallpaperModalClose = document.getElementById('wallpaper-modal-close');
const wallpaperModalSave = document.getElementById('wallpaper-modal-save');
const wallpaperUrlInput = document.getElementById('wallpaper-url-input');
const wallpaperOpacityInput = document.getElementById('wallpaper-opacity-input');
const opacityVal = document.getElementById('opacity-val');
const resetWallpaperBtn = document.getElementById('reset-wallpaper-btn');

const prepromptModal = document.getElementById('preprompt-modal');
const managePrepromptsBtn = document.getElementById('manage-preprompts-btn');
const prepromptModalClose = document.getElementById('preprompt-modal-close');
const prepromptModalDone = document.getElementById('preprompt-modal-done');
const prepromptItemsContainer = document.getElementById('preprompt-items-container');
const newPromptTitle = document.getElementById('new-prompt-title');
const newPromptContent = document.getElementById('new-prompt-content');
const addPromptBtn = document.getElementById('add-prompt-btn');
const prepromptsList = document.getElementById('preprompts-list');

// ==========================================
// INITIALIZATION
// ==========================================
window.addEventListener('DOMContentLoaded', async () => {
  customIgnorePatterns = await dbLoadSetting('custom_ignores', ['*.test.*', '*.spec.*', '*.svg']);
  savedPrePrompts = await dbLoadSetting('saved_preprompts', savedPrePrompts);
  includeAsciiTree = await dbLoadSetting('include_ascii_tree', true);
  currentWallpaper = await dbLoadSetting('wallpaper_url', DEFAULT_WALLPAPER);
  currentOpacity = await dbLoadSetting('wallpaper_opacity', 0.45);

  includeTreeToggle.checked = includeAsciiTree;
  applyWallpaper(currentWallpaper, currentOpacity);

  const saved = await dbLoadAllFiles();
  saved.forEach((item) => {
    loadedFiles.set(item.path, {
      content: item.content,
      lines: item.lines,
      chars: item.chars,
      included: item.included !== false
    });
  });

  renderPrePromptChips();
  updateUI();
});

function applyWallpaper(url, opacity) {
  previewArtwork.style.backgroundImage = `url("${url}")`;
  previewArtwork.style.opacity = opacity;
}

// Window drop prevention
window.addEventListener('dragover', (e) => e.preventDefault(), false);
window.addEventListener('drop', (e) => e.preventDefault(), false);

// Pickers
selectFilesTrigger.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
selectFolderTrigger.addEventListener('click', (e) => { e.stopPropagation(); folderInput.click(); });
selectLogTrigger.addEventListener('click', (e) => { e.stopPropagation(); openPasteModal(); });
openPasteModalBtn.addEventListener('click', () => openPasteModal());

dropZone.addEventListener('click', (e) => {
  if (e.target !== selectFilesTrigger && e.target !== selectFolderTrigger && e.target !== selectLogTrigger) {
    fileInput.click();
  }
});

fileInput.addEventListener('change', (e) => handleLegacyFiles(e.target.files));
folderInput.addEventListener('change', (e) => handleLegacyFiles(e.target.files));

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('hover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('hover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('hover');
  const items = e.dataTransfer.items;
  if (items) {
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }
    processEntries(entries);
  } else {
    handleLegacyFiles(e.dataTransfer.files);
  }
});

// Global Paste (Ctrl+V)
window.addEventListener('paste', (e) => {
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  if (activeTag === 'input' || activeTag === 'textarea') return;

  const text = e.clipboardData ? e.clipboardData.getData('text') : '';
  if (text && text.trim().length > 0) {
    e.preventDefault();
    openPasteModal(text);
  }
});

// Search & Tree Controls
searchFilter.addEventListener('input', () => updateUI());

toggleAllBtn.addEventListener('click', () => {
  const allIncluded = Array.from(loadedFiles.values()).every(f => f.included);
  const targetState = !allIncluded;
  loadedFiles.forEach(f => f.included = targetState);
  persistFiles();
  updateUI();
});

collapseAllBtn.addEventListener('click', () => {
  const allDirs = getAllDirectories();
  if (collapsedFolders.size > 0) {
    collapsedFolders.clear();
  } else {
    allDirs.forEach(d => collapsedFolders.add(d));
  }
  updateUI();
});

includeTreeToggle.addEventListener('change', (e) => {
  includeAsciiTree = e.target.checked;
  dbSaveSetting('include_ascii_tree', includeAsciiTree);
  updateUI();
});

// Wallpaper Modal
openWallpaperModalBtn.addEventListener('click', () => {
  wallpaperUrlInput.value = currentWallpaper;
  wallpaperOpacityInput.value = Math.round(currentOpacity * 100);
  opacityVal.textContent = `${wallpaperOpacityInput.value}%`;
  wallpaperModal.classList.add('open');
});

wallpaperOpacityInput.addEventListener('input', (e) => {
  opacityVal.textContent = `${e.target.value}%`;
});

wallpaperModalClose.addEventListener('click', () => wallpaperModal.classList.remove('open'));

resetWallpaperBtn.addEventListener('click', () => {
  wallpaperUrlInput.value = DEFAULT_WALLPAPER;
  wallpaperOpacityInput.value = 45;
  opacityVal.textContent = '45%';
});

wallpaperModalSave.addEventListener('click', () => {
  currentWallpaper = wallpaperUrlInput.value.trim() || DEFAULT_WALLPAPER;
  currentOpacity = parseFloat(wallpaperOpacityInput.value) / 100;
  applyWallpaper(currentWallpaper, currentOpacity);
  dbSaveSetting('wallpaper_url', currentWallpaper);
  dbSaveSetting('wallpaper_opacity', currentOpacity);
  wallpaperModal.classList.remove('open');
});

// Pre-Prompts
function renderPrePromptChips() {
  prepromptsList.innerHTML = '';
  savedPrePrompts.forEach(p => {
    const chip = document.createElement('div');
    chip.className = `preprompt-chip ${activePromptId === p.id ? 'active' : ''}`;
    chip.textContent = p.title;
    chip.title = p.content;
    chip.addEventListener('click', () => {
      activePromptId = activePromptId === p.id ? null : p.id;
      renderPrePromptChips();
      updateUI();
    });
    prepromptsList.appendChild(chip);
  });
}

managePrepromptsBtn.addEventListener('click', () => {
  renderPrePromptManager();
  prepromptModal.classList.add('open');
});

prepromptModalClose.addEventListener('click', () => prepromptModal.classList.remove('open'));
prepromptModalDone.addEventListener('click', () => prepromptModal.classList.remove('open'));

addPromptBtn.addEventListener('click', () => {
  const title = newPromptTitle.value.trim();
  const content = newPromptContent.value.trim();
  if (!title || !content) return alert('Please enter both title and content.');
  savedPrePrompts.push({ id: Date.now().toString(), title, content });
  newPromptTitle.value = '';
  newPromptContent.value = '';
  dbSaveSetting('saved_preprompts', savedPrePrompts);
  renderPrePromptChips();
  renderPrePromptManager();
});

function renderPrePromptManager() {
  prepromptItemsContainer.innerHTML = '';
  savedPrePrompts.forEach(p => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;background:#0d1117;border:1px solid var(--border-color);padding:6px 10px;border-radius:4px;';
    item.innerHTML = `
      <div style="flex:1;overflow:hidden;">
        <div style="font-size:0.8rem;font-weight:600;color:var(--text-main);">${p.title}</div>
        <div style="font-size:0.7rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.content}</div>
      </div>
      <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1rem;padding:0 6px;">&times;</button>
    `;
    item.querySelector('button').addEventListener('click', () => {
      savedPrePrompts = savedPrePrompts.filter(x => x.id !== p.id);
      if (activePromptId === p.id) activePromptId = null;
      dbSaveSetting('saved_preprompts', savedPrePrompts);
      renderPrePromptChips();
      renderPrePromptManager();
      updateUI();
    });
    prepromptItemsContainer.appendChild(item);
  });
}

// Ignore Modal
openIgnoreModalBtn.addEventListener('click', () => {
  ignorePatternsInput.value = customIgnorePatterns.join('\n');
  ignoreModal.classList.add('open');
});

ignoreModalClose.addEventListener('click', () => ignoreModal.classList.remove('open'));
ignoreModalCancel.addEventListener('click', () => ignoreModal.classList.remove('open'));
ignoreModalSave.addEventListener('click', () => {
  customIgnorePatterns = ignorePatternsInput.value.split('\n').map(s => s.trim()).filter(Boolean);
  dbSaveSetting('custom_ignores', customIgnorePatterns);
  ignoreModal.classList.remove('open');
});

function matchesCustomIgnore(path) {
  if (customIgnorePatterns.length === 0) return false;
  return customIgnorePatterns.some(pattern => {
    const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(regexStr, 'i').test(path) || path.includes(pattern.replace(/\*/g, ''));
  });
}

// Paste Modal
function openPasteModal(defaultText = '') {
  pasteModal.classList.add('open');
  logContentInput.value = defaultText;

  let logIndex = 1;
  let defaultName = 'error.log';
  while (loadedFiles.has(`logs/${defaultName}`)) {
    logIndex++;
    defaultName = `error-${logIndex}.log`;
  }
  logNameInput.value = defaultName;

  setTimeout(() => {
    if (defaultText) logNameInput.focus();
    else logContentInput.focus();
  }, 60);
}

function closePasteModal() {
  pasteModal.classList.remove('open');
  logNameInput.value = '';
  logContentInput.value = '';
}

pasteModalClose.addEventListener('click', closePasteModal);
pasteModalCancel.addEventListener('click', closePasteModal);
logContentInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitPastedLog();
});
pasteModalSubmit.addEventListener('click', submitPastedLog);

function submitPastedLog() {
  const content = logContentInput.value;
  if (!content.trim()) return alert('Please paste some text/log first.');
  let name = logNameInput.value.trim() || 'error.log';
  const relativePath = name.includes('/') ? name : `logs/${name}`;

  const lines = content.split('\n').length;
  const chars = content.length;

  loadedFiles.set(relativePath, { content, lines, chars, included: true });
  persistFiles();
  updateUI();
  closePasteModal();
}

// ==========================================
// FILE PROCESSING
// ==========================================
function isTextFile(file, content) {
  if (file.size > MAX_FILE_SIZE_BYTES) return false;
  const binaryExtensions = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|rar|7z|exe|dll|so|dylib|bin|mp3|mp4|wav|avi|mov|woff2?|ttf|otf|pyc|class|db|sqlite|node)$/i;
  if (binaryExtensions.test(file.name)) return false;
  if (content.includes('\u0000')) return false;
  return true;
}

function handleLegacyFiles(files) {
  const filesToProcess = Array.from(files).map(file => ({
    file,
    relativePath: file.webkitRelativePath || file.name
  }));
  processParsedFiles(filesToProcess);
}

async function processEntries(entries) {
  const filesToProcess = [];

  async function readAllDirectoryEntries(dirEntry) {
    const reader = dirEntry.createReader();
    const all = [];
    const readBatch = () => new Promise((res, rej) => reader.readEntries(res, rej));
    try {
      let results = await readBatch();
      while (results.length > 0) {
        all.push(...results);
        results = await readBatch();
      }
    } catch (err) {
      console.error(err);
    }
    return all;
  }

  async function traverse(entry, path = "") {
    if (entry.isDirectory && DEFAULT_IGNORED_FOLDERS.has(entry.name)) return;
    if (entry.isFile && DEFAULT_IGNORED_FILES.has(entry.name)) return;

    const relativePath = path ? `${path}/${entry.name}` : entry.name;
    if (matchesCustomIgnore(relativePath)) return;

    if (entry.isFile) {
      const file = await new Promise(res => entry.file(res));
      filesToProcess.push({ file, relativePath });
    } else if (entry.isDirectory) {
      const subEntries = await readAllDirectoryEntries(entry);
      for (const sub of subEntries) {
        await traverse(sub, relativePath);
      }
    }
  }

  for (const entry of entries) {
    await traverse(entry);
  }
  processParsedFiles(filesToProcess);
}

function processParsedFiles(fileList) {
  const filteredList = fileList.filter(({ file, relativePath }) => {
    const parts = relativePath.split('/');
    const hasIgnoredFolder = parts.some(p => DEFAULT_IGNORED_FOLDERS.has(p));
    const isIgnoredFile = DEFAULT_IGNORED_FILES.has(file.name);
    return !hasIgnoredFolder && !isIgnoredFile && !matchesCustomIgnore(relativePath);
  });

  const promises = filteredList.map(({ file, relativePath }) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target.result;
        if (!isTextFile(file, content)) return resolve();
        const lines = content.split('\n').length;
        const chars = content.length;
        loadedFiles.set(relativePath, { content, lines, chars, included: true });
        resolve();
      };
      reader.onerror = () => resolve();
      reader.readAsText(file);
    });
  });

  Promise.all(promises).then(() => {
    persistFiles();
    updateUI();
    fileInput.value = '';
    folderInput.value = '';
  });
}

function removeFile(relativePath) {
  loadedFiles.delete(relativePath);
  persistFiles();
  updateUI();
}

function removeDirectory(dirPath) {
  loadedFiles.forEach((_, path) => {
    if (path.startsWith(dirPath + '/')) {
      loadedFiles.delete(path);
    }
  });
  persistFiles();
  updateUI();
}

function persistFiles() {
  dbSaveAllFiles(loadedFiles);
}

function getAllDirectories() {
  const dirs = new Set();
  loadedFiles.forEach((_, path) => {
    const parts = path.split('/');
    parts.pop();
    let current = '';
    parts.forEach(p => {
      current = current ? `${current}/${p}` : p;
      dirs.add(current);
    });
  });
  return Array.from(dirs);
}

// ==========================================
// VS CODE HIERARCHICAL TREE ENGINE
// ==========================================
function buildHierarchy() {
  const root = { name: '', path: '', isDir: true, children: new Map(), files: [] };

  loadedFiles.forEach((data, path) => {
    const parts = path.split('/');
    const fileName = parts.pop();
    let current = root;

    let accumulatedPath = '';
    parts.forEach(part => {
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: accumulatedPath,
          isDir: true,
          children: new Map(),
          files: []
        });
      }
      current = current.children.get(part);
    });

    current.files.push({ name: fileName, path, data });
  });

  return root;
}

function getDirState(dirNode) {
  let allCount = 0;
  let includedCount = 0;

  function count(node) {
    node.files.forEach(f => {
      allCount++;
      if (f.data.included) includedCount++;
    });
    node.children.forEach(c => count(c));
  }

  count(dirNode);
  if (allCount === 0) return { checked: false, indeterminate: false };
  if (includedCount === allCount) return { checked: true, indeterminate: false };
  if (includedCount > 0) return { checked: false, indeterminate: true };
  return { checked: false, indeterminate: false };
}

function setDirIncluded(dirNode, state) {
  dirNode.files.forEach(f => f.data.included = state);
  dirNode.children.forEach(c => setDirIncluded(c, state));
}

function renderTree() {
  fileTreeEl.innerHTML = '';
  const filterTerm = searchFilter.value.trim().toLowerCase();
  const root = buildHierarchy();

  function matchesFilter(node) {
    if (!filterTerm) return true;
    const hasMatchingFile = node.files.some(f => f.path.toLowerCase().includes(filterTerm));
    if (hasMatchingFile) return true;
    for (const child of node.children.values()) {
      if (matchesFilter(child)) return true;
    }
    return false;
  }

  function renderDir(dirNode, container, depth = 0) {
    // Sort subdirectories and files alphabetically
    const sortedDirs = Array.from(dirNode.children.values()).sort((a, b) => a.name.localeCompare(b.name));
    const sortedFiles = dirNode.files.sort((a, b) => a.name.localeCompare(b.name));

    // Render Subdirectories
    sortedDirs.forEach(child => {
      if (!matchesFilter(child)) return;

      const isCollapsed = filterTerm ? false : collapsedFolders.has(child.path);
      const state = getDirState(child);

      const row = document.createElement('div');
      row.className = 'tree-row folder';
      row.style.paddingLeft = `${depth * 14 + 6}px`;

      row.innerHTML = `
        <span class="tree-chevron ${isCollapsed ? '' : 'expanded'}">▶</span>
        <input type="checkbox" class="tree-folder-checkbox" ${state.checked ? 'checked' : ''}>
        <span class="tree-icon">${isCollapsed ? '📁' : '📂'}</span>
        <span class="tree-label" title="${child.path}">${child.name}</span>
        <button class="tree-delete-btn" title="Remove directory">&times;</button>
      `;

      const checkbox = row.querySelector('.tree-folder-checkbox');
      checkbox.indeterminate = state.indeterminate;

      // Expand / Collapse click
      row.addEventListener('click', (e) => {
        if (e.target === checkbox || e.target.classList.contains('tree-delete-btn')) return;
        if (collapsedFolders.has(child.path)) {
          collapsedFolders.delete(child.path);
        } else {
          collapsedFolders.add(child.path);
        }
        updateUI();
      });

      checkbox.addEventListener('change', (e) => {
        setDirIncluded(child, e.target.checked);
        persistFiles();
        updateUI();
      });

      row.querySelector('.tree-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Remove directory "${child.name}" and all contents?`)) {
          removeDirectory(child.path);
        }
      });

      container.appendChild(row);

      if (!isCollapsed) {
        renderDir(child, container, depth + 1);
      }
    });

    // Render Files
    sortedFiles.forEach(({ name, path, data }) => {
      if (filterTerm && !path.toLowerCase().includes(filterTerm)) return;

      const row = document.createElement('div');
      row.className = `tree-row file ${data.included ? '' : 'excluded'}`;
      row.style.paddingLeft = `${depth * 14 + 20}px`;

      const sizeStr = data.chars > 1024 ? `${(data.chars / 1024).toFixed(1)}K` : `${data.chars}B`;

      row.innerHTML = `
        <input type="checkbox" class="tree-file-checkbox" ${data.included ? 'checked' : ''}>
        <span class="tree-icon">📄</span>
        <span class="tree-label" title="${path}">${name}</span>
        <span class="tree-stats">${data.lines}L • ${sizeStr}</span>
        <button class="tree-delete-btn" title="Remove file">&times;</button>
      `;

      const checkbox = row.querySelector('.tree-file-checkbox');
      checkbox.addEventListener('change', (e) => {
        data.included = e.target.checked;
        persistFiles();
        updateUI();
      });

      row.querySelector('.tree-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        removeFile(path);
      });

      container.appendChild(row);
    });
  }

  renderDir(root, fileTreeEl, 0);
}

// ==========================================
// ASCII PROJECT TREE BUILDER
// ==========================================
function buildAsciiTree(paths) {
  if (paths.length === 0) return '';
  const root = {};

  paths.forEach(path => {
    const parts = path.split('/');
    let current = root;
    parts.forEach(part => {
      current[part] = current[part] || {};
      current = current[part];
    });
  });

  let treeString = 'PROJECT STRUCTURE:\n.\n';

  function generate(node, prefix = '') {
    const keys = Object.keys(node).sort((a, b) => {
      const aIsDir = Object.keys(node[a]).length > 0;
      const bIsDir = Object.keys(node[b]).length > 0;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    keys.forEach((key, index) => {
      const isLast = index === keys.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      const isDirectory = Object.keys(node[key]).length > 0;

      treeString += `${prefix}${connector}${key}${isDirectory ? '/' : ''}\n`;
      if (isDirectory) {
        generate(node[key], prefix + childPrefix);
      }
    });
  }

  generate(root);
  return treeString;
}

// ==========================================
// UI RE-RENDER & OUTPUT GENERATION
// ==========================================
function updateUI() {
  renderTree();

  let activeLines = 0;
  let activeChars = 0;
  let includedFilesCount = 0;
  const includedPathsForTree = [];
  let combinedBody = '';

  // 1. Pre-Prompt
  if (activePromptId) {
    const activePrompt = savedPrePrompts.find(p => p.id === activePromptId);
    if (activePrompt) {
      combinedBody += `// ====================================\n`;
      combinedBody += `// INSTRUCTION / PROMPT:\n`;
      combinedBody += `// ====================================\n`;
      combinedBody += activePrompt.content + `\n\n`;
    }
  }

  // 2. Sort files and generate content
  const sortedFiles = new Map([...loadedFiles.entries()].sort());

  sortedFiles.forEach((data, relativePath) => {
    if (data.included) {
      includedFilesCount++;
      activeLines += data.lines;
      activeChars += data.chars;
      includedPathsForTree.push(relativePath);

      combinedBody += `// ====================================\n`;
      combinedBody += `// FILE: ${relativePath}\n`;
      combinedBody += `// LINES: ${data.lines} | CHARACTERS: ${data.chars}\n`;
      combinedBody += `// ====================================\n\n`;
      combinedBody += data.content + `\n\n`;
    }
  });

  // 3. Optional ASCII Project Structure Tree
  if (includeAsciiTree && includedPathsForTree.length > 0) {
    const asciiTree = buildAsciiTree(includedPathsForTree);
    combinedBody = `// ====================================\n` +
      `// ${asciiTree.replace(/\n/g, '\n// ')}\n` +
      `// ====================================\n\n` + combinedBody;
  }

  // 4. Update Stats
  const sizeKB = (activeChars / 1024).toFixed(1);
  const sizeMB = (activeChars / (1024 * 1024)).toFixed(2);
  const displaySize = activeChars > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
  const estTokens = Math.round(activeChars / 3.8);

  totalFilesEl.textContent = `${includedFilesCount} / ${loadedFiles.size}`;
  totalLinesEl.textContent = activeLines.toLocaleString();
  totalSizeEl.textContent = displaySize;
  totalTokensEl.textContent = `~${estTokens.toLocaleString()}`;

  outputPreview.value = combinedBody;
}

// ==========================================
// EXPORT & ACTIONS
// ==========================================
copyBtn.addEventListener('click', () => {
  if (!outputPreview.value.trim()) return;
  navigator.clipboard.writeText(outputPreview.value);
  const original = copyBtn.innerHTML;
  copyBtn.innerHTML = '✅ Copied to Clipboard!';
  setTimeout(() => { copyBtn.innerHTML = original; }, 1500);
});

clearBtn.addEventListener('click', () => {
  if (confirm('Clear all files and logs from workspace?')) {
    loadedFiles.clear();
    persistFiles();
    updateUI();
  }
});

function downloadFile(ext) {
  if (!outputPreview.value.trim()) return;
  const blob = new Blob([outputPreview.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `combined-code-${new Date().toISOString().slice(0, 10)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

downloadTxtBtn.addEventListener('click', () => downloadFile('txt'));
downloadMdBtn.addEventListener('click', () => downloadFile('md'));