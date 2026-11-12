// ==========================================
// INDEXEDDB STORAGE ENGINE
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
const loadedFiles = new Map();

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
const triggerClashBtn = document.getElementById('trigger-clash-btn');

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

  includeTreeToggle.checked = includeAsciiTree;

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
  initCinematicStickDuel();
});

// Window Drag & Drops
window.addEventListener('dragover', (e) => e.preventDefault(), false);
window.addEventListener('drop', (e) => e.preventDefault(), false);

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

// Global Paste
window.addEventListener('paste', (e) => {
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  if (activeTag === 'input' || activeTag === 'textarea') return;

  const text = e.clipboardData ? e.clipboardData.getData('text') : '';
  if (text && text.trim().length > 0) {
    e.preventDefault();
    openPasteModal(text);
  }
});

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

// ==========================================
// CINEMATIC SAMURAI CHOREOGRAPHY ENGINE
// ==========================================
function initCinematicStickDuel() {
  const canvas = document.getElementById('duel-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let width = canvas.width = canvas.offsetWidth;
  let height = canvas.height = canvas.offsetHeight;

  window.addEventListener('resize', () => {
    width = canvas.width = canvas.offsetWidth;
    height = canvas.height = canvas.offsetHeight;
  });

  const sparks = [];
  const slashes = [];
  const dusts = [];
  const petals = [];

  for (let i = 0; i < 35; i++) {
    petals.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: 0.6 + Math.random() * 1.4,
      vy: 0.3 + Math.random() * 0.7,
      size: 2.5 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      rotSpeed: (Math.random() - 0.5) * 0.04
    });
  }

  let screenShake = 0;

  // The Two Samurai Fighters
  const f1 = {
    x: -80, // Starts off-screen left
    y: 0,
    vx: 0,
    vy: 0,
    facing: 1,
    color: '#ef4444',
    bladeColor: '#fca5a5',
    sheathed: true,
    sheathProgress: 0,
    swordAngle: -1.2,
    tilt: 0,
    legPhase: 0,
    trail: []
  };

  const f2 = {
    x: width + 80, // Starts off-screen right
    y: 0,
    vx: 0,
    vy: 0,
    facing: -1,
    color: '#06b6d4',
    bladeColor: '#67e8f9',
    sheathed: true,
    sheathProgress: 0,
    swordAngle: 1.2,
    tilt: 0,
    legPhase: Math.PI,
    trail: []
  };

  // Choreography sequence:
  // 1. ENTRANCE (Walk in from both walls)
  // 2. DRAW (Quick-draw unsheath with blade glint)
  // 3. STALK (Slow pacing, testing range)
  // 4. FEINT_PARRY (Probe thrust, instant block)
  // 5. COMBO_CLASH (3-hit high-low exchange)
  // 6. POWER_LOCK (Lock blades at center with sparks and vibration)
  // 7. PUSH_KICK (Slide backwards across floor)
  // 8. AERIAL_LEAP (Mid-air somersault cross-slash)
  // 9. SHEATHE_RESET (Resheath katana, pause, reset)
  let battleState = 'ENTRANCE';
  let stateTimer = 0;
  let ticks = 0;

  function emitSparks(x, y, count = 25, power = 1) {
    screenShake = Math.min(10, count * 0.25);
    for (let i = 0; i < count; i++) {
      const angle = (Math.random() - 0.5) * Math.PI * 1.9;
      const speed = (4 + Math.random() * 12) * power;
      sparks.push({
        x: x,
        y: y + (Math.random() - 0.5) * 16,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2.5,
        life: 1,
        decay: 0.02 + Math.random() * 0.035,
        color: Math.random() > 0.4 ? '#fef08a' : '#fb923c'
      });
    }

    slashes.push({
      x: x,
      y: y,
      radius: 20 + Math.random() * 25,
      life: 1,
      startAngle: Math.random() * Math.PI * 2,
      sweep: Math.PI * (0.45 + Math.random() * 0.35),
      color: Math.random() > 0.5 ? '#fca5a5' : '#67e8f9'
    });
  }

  function emitDust(x, y, count = 6) {
    for (let i = 0; i < count; i++) {
      dusts.push({
        x: x + (Math.random() - 0.5) * 20,
        y: y - 2,
        vx: (Math.random() - 0.5) * 3,
        vy: -Math.random() * 2,
        life: 1,
        size: 3 + Math.random() * 5
      });
    }
  }

  function triggerInteractiveClash() {
    f1.sheathed = false;
    f2.sheathed = false;
    battleState = 'CLOSE_IN';
    stateTimer = 0;
  }

  triggerClashBtn.addEventListener('click', triggerInteractiveClash);
  let inputClashTimeout;
  outputPreview.addEventListener('input', () => {
    clearTimeout(inputClashTimeout);
    inputClashTimeout = setTimeout(triggerInteractiveClash, 250);
  });

  function render() {
    ticks++;
    stateTimer++;
    ctx.clearRect(0, 0, width, height);
    const groundY = height * 0.80;

    // Apply Screen Shake
    ctx.save();
    if (screenShake > 0.1) {
      const shakeX = (Math.random() - 0.5) * screenShake * 2;
      const shakeY = (Math.random() - 0.5) * screenShake * 2;
      ctx.translate(shakeX, shakeY);
      screenShake *= 0.85;
    }

    // ==========================================
    // THE CHOREOGRAPHY SCRIPT
    // ==========================================
    if (battleState === 'ENTRANCE') {
      // Walk out from the edge walls towards their starting marks
      f1.sheathed = true;
      f2.sheathed = true;
      f1.facing = 1;
      f2.facing = -1;

      const targetX1 = width * 0.35;
      const targetX2 = width * 0.65;

      f1.vx = (targetX1 - f1.x) * 0.05;
      f2.vx = (targetX2 - f2.x) * 0.05;

      f1.tilt = 0.1;
      f2.tilt = -0.1;

      if (Math.abs(f1.x - targetX1) < 4 && Math.abs(f2.x - targetX2) < 4) {
        battleState = 'DRAW';
        stateTimer = 0;
      }
    } else if (battleState === 'DRAW') {
      // Pause, hand reaches to hip, thumb glints, snap-draws blade!
      f1.vx = 0;
      f2.vx = 0;

      if (stateTimer < 14) {
        // Tense pause
        f1.tilt = 0.05;
        f2.tilt = -0.05;
      } else if (stateTimer === 14) {
        // Quick-draw flash!
        f1.sheathed = false;
        f2.sheathed = false;
        emitSparks(f1.x + 25, groundY - 50, 15, 0.6);
        emitSparks(f2.x - 25, groundY - 50, 15, 0.6);
      } else if (stateTimer > 22) {
        battleState = 'STALK';
        stateTimer = 0;
      }
    } else if (battleState === 'STALK') {
      // Circling, testing distance
      f1.vx = Math.sin(ticks * 0.05) * 0.8;
      f2.vx = -Math.sin(ticks * 0.05) * 0.8;

      const guardAngle = -0.08 + Math.sin(ticks * 0.08) * 0.08;
      f1.swordAngle = guardAngle;
      f2.swordAngle = guardAngle;
      f1.tilt = 0.12;
      f2.tilt = -0.12;

      if (stateTimer > 45) {
        battleState = 'CLOSE_IN';
        stateTimer = 0;
      }
    } else if (battleState === 'CLOSE_IN') {
      f1.sheathed = false;
      f2.sheathed = false;
      f1.swordAngle = 0;
      f2.swordAngle = 0;
      f1.tilt = 0.1;
      f2.tilt = -0.1;

      const clashGap = Math.min(170, Math.max(140, width * 0.2));
      const targetX1 = width / 2 - clashGap / 2;
      const targetX2 = width / 2 + clashGap / 2;
      const distance1 = targetX1 - f1.x;
      const distance2 = targetX2 - f2.x;
      f1.vx = Math.max(-12, Math.min(12, distance1 * 0.22));
      f2.vx = Math.max(-12, Math.min(12, distance2 * 0.22));

      if (Math.abs(distance1) < 3 && Math.abs(distance2) < 3) {
        f1.x = targetX1;
        f2.x = targetX2;
        f1.vx = 0;
        f2.vx = 0;
        battleState = 'FEINT_PARRY';
        stateTimer = 0;
        emitSparks(width / 2, groundY - 68, 12, 0.65);
      }
    } else if (battleState === 'FEINT_PARRY') {
      if (stateTimer < 10) {
        // Windup (anticipation)
        f1.vx = -0.8;
        f1.swordAngle = -0.75;
        f2.swordAngle = 0.1;
        f1.tilt = -0.1;
      } else if (stateTimer < 20) {
        f1.vx = 2.5;
        f1.swordAngle = 0.32;
        f2.swordAngle = 0.32;
        f1.tilt = 0.25;
      } else if (stateTimer === 20) {
        emitSparks(width / 2, groundY - 67, 24, 1.1);
        f1.vx = -2;
        f2.vx = 2;
      } else if (stateTimer > 34) {
        battleState = 'COMBO_CLASH';
        stateTimer = 0;
      }
    } else if (battleState === 'COMBO_CLASH') {
      // 3-hit rapid exchange
      if (stateTimer < 15) {
        // Hit 1: Red overhead slash -> Cyan high block
        f1.swordAngle = -1;
        f2.swordAngle = -1;
        if (stateTimer === 10)         emitSparks(width / 2, groundY - 112, 22);
      } else if (stateTimer < 30) {
        // Hit 2: Cyan sweeps low -> Red hops
        f2.swordAngle = 0.7;
        f1.swordAngle = 0.7;
        if (stateTimer === 22) {
          f1.vy = -6; // Little hop
          emitSparks(width / 2, groundY - 18, 22);
        }
      } else if (stateTimer < 45) {
        // Hit 3: Simultaneous lunge into center lock
        f1.swordAngle = 0.25;
        f2.swordAngle = 0.25;
        if (stateTimer === 38) emitSparks(width / 2, groundY - 50, 26, 1.15);
      } else {
        battleState = 'POWER_LOCK';
        stateTimer = 0;
        emitSparks(width / 2, groundY - 62, 35, 1.2);
      }
    } else if (battleState === 'POWER_LOCK') {
      // Crossed swords locked, straining against each other
      f1.vx = 0;
      f2.vx = 0;
      f1.tilt = 0.28;
      f2.tilt = -0.28;
      const lockAngle = 0.35 + Math.sin(ticks * 0.22) * 0.035;
      f1.swordAngle = lockAngle;
      f2.swordAngle = lockAngle;

      if (ticks % 5 === 0) {
        emitSparks(width / 2, groundY - 45, 7, 0.7);
      }

      if (stateTimer > 72) {
        battleState = 'PUSH_KICK';
        stateTimer = 0;
        f1.vx = -10;
        f2.vx = 10;
        emitDust(f1.x, groundY, 10);
        emitDust(f2.x, groundY, 10);
        emitSparks(width / 2, groundY - 60, 30);
      }
    } else if (battleState === 'PUSH_KICK') {
      // Sliding back, kicking up dust
      f1.tilt = -0.35;
      f2.tilt = 0.35;
      f1.swordAngle = -0.6;
      f2.swordAngle = 0.6;

      if (ticks % 4 === 0) {
        emitDust(f1.x, groundY, 2);
        emitDust(f2.x, groundY, 2);
      }

      if (stateTimer > 35) {
        battleState = 'AERIAL_LEAP';
        stateTimer = 0;
        f1.vy = -13;
        f2.vy = -13;
        f1.vx = 5;
        f2.vx = -5;
      }
    } else if (battleState === 'AERIAL_LEAP') {
      // Mid-air flip clash
      const aerialGap = Math.min(190, Math.max(150, width * 0.22));
      const aerialTarget1 = width / 2 - aerialGap / 2;
      const aerialTarget2 = width / 2 + aerialGap / 2;
      f1.vx = Math.max(-7, Math.min(7, (aerialTarget1 - f1.x) * 0.12));
      f2.vx = Math.max(-7, Math.min(7, (aerialTarget2 - f2.x) * 0.12));
      f1.swordAngle = -0.55;
      f2.swordAngle = -0.55;

      if (Math.abs(f1.x - f2.x) <= aerialGap + 12 && f1.y < groundY - 40) {
        if (ticks % 6 === 0) emitSparks(width / 2, (f1.y + f2.y) / 2 - 45, 20);
      }

      if (stateTimer > 60 && f1.y >= groundY && f2.y >= groundY) {
        battleState = 'SHEATHE_RESET';
        stateTimer = 0;
        emitDust(f1.x, groundY, 8);
        emitDust(f2.x, groundY, 8);
      }
    } else if (battleState === 'SHEATHE_RESET') {
      // Land in crouch, stand up, resheathe katana with glint
      f1.vx = 0;
      f2.vx = 0;

      if (stateTimer < 20) {
        // Deep crouch landing
        f1.tilt = 0.2;
        f2.tilt = -0.2;
      } else if (stateTimer === 35) {
        // Click into sheath
        f1.sheathed = true;
        f2.sheathed = true;
        emitSparks(f1.x + 20, groundY - 45, 6, 0.4);
        emitSparks(f2.x - 20, groundY - 45, 6, 0.4);
      } else if (stateTimer > 60) {
        battleState = 'STALK';
        stateTimer = 0;
      }
    }

    // Physics Update
    [f1, f2].forEach(f => {
      f.x += f.vx;
      f.y += f.vy;
      f.vx *= 0.88;

      if (f.y < groundY) {
        f.vy += 0.65; // Gravity
      } else {
        f.y = groundY;
        f.vy = 0;
      }
    });

    // Hard Collision Barrier (They never overlap or cross)
    const MIN_DISTANCE = 56;
    if (battleState !== 'ENTRANCE' && (f2.x - f1.x < MIN_DISTANCE)) {
      const mid = (f1.x + f2.x) / 2;
      f1.x = mid - MIN_DISTANCE / 2;
      f2.x = mid + MIN_DISTANCE / 2;
    }

    // Keep on screen (except during entrance)
    if (battleState !== 'ENTRANCE') {
      f1.x = Math.max(width * 0.08, Math.min(width * 0.48, f1.x));
      f2.x = Math.max(width * 0.52, Math.min(width * 0.92, f2.x));
    }

    // ==========================================
    // DRAW ENVIRONMENT
    // ==========================================

    // Moon Glow
    const moonX = width * 0.5;
    const moonY = height * 0.28;
    const moonGrad = ctx.createRadialGradient(moonX, moonY, 15, moonX, moonY, 150);
    moonGrad.addColorStop(0, 'rgba(255, 245, 230, 0.16)');
    moonGrad.addColorStop(0.5, 'rgba(239, 68, 68, 0.05)');
    moonGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = moonGrad;
    ctx.beginPath();
    ctx.arc(moonX, moonY, 150, 0, Math.PI * 2);
    ctx.fill();

    // Ground Platform Line
    ctx.strokeStyle = 'rgba(75, 85, 99, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(width * 0.04, groundY);
    ctx.lineTo(width * 0.96, groundY);
    ctx.stroke();

    // ==========================================
    // DRAW FIGHTER RIG
    // ==========================================
    function drawFighter(f) {
      ctx.save();

      const shadowScale = Math.max(0.2, 1 - (groundY - f.y) / 160);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
      ctx.beginPath();
      ctx.ellipse(f.x, groundY + 2, 26 * shadowScale, 6 * shadowScale, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.translate(f.x, f.y);
      ctx.scale(f.facing, 1);
      const aura = 1 + Math.sin(ticks * 0.18 + f.x * 0.04) * 0.12;
      ctx.strokeStyle = `${f.color}66`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(0, -38, 22 * aura, 38 * aura, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const isAirborne = f.y < groundY - 5;
      const isRunning = Math.abs(f.vx) > 1;
      if (isRunning) f.legPhase += 0.28;

      const hipX = 0;
      const hipY = -46;
      const neckX = Math.sin(f.tilt) * 36;
      const neckY = -86;
      const headX = neckX + Math.sin(f.tilt) * 12;
      const headY = neckY - 14;

      function drawLeg(phase, offset) {
        let kneeAngle, footAngle;
        if (isAirborne) {
          kneeAngle = 0.9 + offset * 0.12;
          footAngle = -0.55;
        } else if (isRunning) {
          kneeAngle = Math.sin(f.legPhase + phase) * 0.78 + 0.35;
          footAngle = Math.cos(f.legPhase + phase) * 0.65 - 0.2;
        } else {
          kneeAngle = 0.24 + offset * 0.14;
          footAngle = 0.08 + offset * 0.06;
        }

        const kneeX = hipX + Math.sin(kneeAngle) * 22;
        const kneeY = hipY + Math.cos(kneeAngle) * 22;
        const footX = kneeX + Math.sin(kneeAngle + footAngle) * 22;
        const footY = kneeY + Math.cos(kneeAngle + footAngle) * 22;

        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(hipX, hipY);
        ctx.quadraticCurveTo(kneeX - 4, kneeY - 6, kneeX, kneeY);
        ctx.quadraticCurveTo(kneeX + 6, kneeY + 3, footX, Math.min(0, footY));
        ctx.stroke();
      }

      drawLeg(Math.PI, -1);
      drawLeg(0, 1);

      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      ctx.quadraticCurveTo(hipX - 6, hipY - 18, neckX, neckY);
      ctx.stroke();

      ctx.fillStyle = `${f.color}35`;
      ctx.strokeStyle = `${f.color}cc`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(neckX - 9, neckY + 5);
      ctx.lineTo(neckX + 11, neckY + 5);
      ctx.lineTo(hipX + 12, hipY - 2);
      ctx.lineTo(hipX - 12, hipY - 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(headX, headY, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.shadowColor = f.color;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(headX, headY, 11.5, Math.PI * 0.8, Math.PI * 1.8);
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(headX - 3, headY - 1);
      ctx.lineTo(headX + 3, headY - 1);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(headX - 4, headY + 4);
      ctx.lineTo(headX + 4, headY + 4);
      ctx.stroke();

      const wave = Math.sin(ticks * 0.16 + f.x * 0.05) * 4.5;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.moveTo(headX - 10, headY);
      ctx.quadraticCurveTo(headX - 24, headY + wave, headX - 42, headY - 2 + wave * 1.2);
      ctx.stroke();

      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hipX - 14, hipY - 7);
      ctx.lineTo(hipX + 18, hipY + 14);
      ctx.stroke();

      ctx.lineWidth = 3.4;
      ctx.strokeStyle = '#f8fafc';
      const shoulderX = neckX;
      const shoulderY = neckY + 8;
      let handX, handY;

      if (f.sheathed) {
        handX = hipX - 6;
        handY = hipY - 2;
        ctx.beginPath();
        ctx.moveTo(shoulderX, shoulderY);
        ctx.quadraticCurveTo(shoulderX - 8, shoulderY + 16, handX, handY);
        ctx.stroke();
      } else {
        const elbowX = shoulderX + 12;
        const elbowY = shoulderY + 14;
        handX = shoulderX + 22;
        handY = shoulderY + 11;

        ctx.beginPath();
        ctx.moveTo(shoulderX, shoulderY);
        ctx.quadraticCurveTo(elbowX, elbowY - 2, handX, handY);
        ctx.stroke();

        const secondHandX = handX - 18;
        const secondHandY = handY + 2;
        ctx.beginPath();
        ctx.moveTo(shoulderX - 5, shoulderY + 2);
        ctx.quadraticCurveTo(shoulderX - 16, shoulderY + 16, secondHandX, secondHandY);
        ctx.stroke();

        ctx.save();
        ctx.translate(handX, handY);
        ctx.rotate(f.swordAngle);

        const bladeGradient = ctx.createLinearGradient(0, -6, 0, 2);
        bladeGradient.addColorStop(0, '#f8fafc');
        bladeGradient.addColorStop(0.42, '#cbd5e1');
        bladeGradient.addColorStop(1, '#64748b');
        ctx.fillStyle = bladeGradient;
        ctx.shadowColor = f.bladeColor;
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.moveTo(2, -3);
        ctx.quadraticCurveTo(38, -7, 69, -6);
        ctx.lineTo(78, -7);
        ctx.quadraticCurveTo(52, 1, 2, 3);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(4, -2);
        ctx.quadraticCurveTo(42, -6, 75, -6.5);
        ctx.stroke();

        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(0, -7);
        ctx.lineTo(0, 7);
        ctx.stroke();

        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(-34, 1.4);
        ctx.lineTo(-3, 0);
        ctx.stroke();

        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1.1;
        for (let wrap = -31; wrap < -5; wrap += 5) {
          ctx.beginPath();
          ctx.moveTo(wrap, -1.5);
          ctx.lineTo(wrap + 3, 1.5);
          ctx.stroke();
        }

        ctx.restore();
      }

      ctx.restore();
    }

    drawFighter(f1);
    drawFighter(f2);

    // ==========================================
    // DRAW PARTICLES & VISUAL JUICE
    // ==========================================

    // Dust Clouds
    for (let i = dusts.length - 1; i >= 0; i--) {
      const d = dusts[i];
      d.x += d.vx;
      d.y += d.vy;
      d.life -= 0.04;
      d.size += 0.2;
      if (d.life <= 0) {
        dusts.splice(i, 1);
        continue;
      }
      ctx.fillStyle = `rgba(148, 163, 184, ${d.life * 0.35})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Slashes
    for (let i = slashes.length - 1; i >= 0; i--) {
      const s = slashes[i];
      s.life -= 0.09;
      s.radius += 2.5;
      if (s.life <= 0) {
        slashes.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 12;
      ctx.lineWidth = s.life * 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, s.startAngle, s.startAngle + s.sweep);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Sparks
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.28;
      p.life -= p.decay;

      if (p.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }

      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, p.life * 2.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Floating Sakura Petals
    petals.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.rotSpeed;

      if (p.x > width) p.x = -10;
      if (p.y > height) p.y = -10;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = 'rgba(244, 114, 182, 0.35)';
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size * 1.4, p.size, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    ctx.restore();
    requestAnimationFrame(render);
  }

  render();
}

// ==========================================
// PRE-PROMPTS ENGINE
// ==========================================
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
// VS CODE STYLE HIERARCHY TREE
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
    const sortedDirs = Array.from(dirNode.children.values()).sort((a, b) => a.name.localeCompare(b.name));
    const sortedFiles = dirNode.files.sort((a, b) => a.name.localeCompare(b.name));

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

  // 3. Optional ASCII Project Tree
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