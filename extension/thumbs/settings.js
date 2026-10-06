const KEY = 'yumikoThumbs.settings';

export const DEFAULTS = Object.freeze({
  format: 'png',
  quality: 1,
  upscaler: 'lanczos',
  scale: 2,
  targetWidth: 1920,
  aiModel: 'light',
  lanczosStrength: 3,
  gammaCorrect: true,
  sharpen: 0.35,
  trimBars: false,
  crop169: false,
  folderPrefix: 'Yumiko/Miniaturas/',
  filenameTemplate: '{title}_{w}x{h}_{source}',
  zipBatch: true,
  showFloatingButton: true,
  probePageImages: true,
  maxPageImages: 200,
});

export async function loadSettings() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...(stored[KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ [KEY]: DEFAULTS });
  return { ...DEFAULTS };
}

export function onSettingsChanged(handler) {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    handler({ ...DEFAULTS, ...(changes[KEY].newValue || {}) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}