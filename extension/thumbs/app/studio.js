import { loadSettings, saveSettings, onSettingsChanged } from '../settings.js';
import { buildCandidateList, probeCandidates, extractVideoId, probeImage } from '../thumbnails.js';
import { parseMeta } from '../page.js';
import { processImage, plan } from '../pipeline.js';
import { AI_MODELS } from '../model-store.js';
import { createZip } from '../zip.js';
import { buildFilename as buildFilenamePath, buildZipPath } from '../filename.js';
import { formatBytes } from '../encode.js';

const NS = 'yumiko-thumbs';
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  context: null,
  tab: 'video',
  video: { id: null, title: '', candidates: [], loading: false },
  page: [],
  selection: { video: new Set(), page: new Set() },
  busy: false,
};

function toBridge(type, payload = {}) {
  if (window.parent !== window) window.parent.postMessage({ ns: NS, type, payload }, '*');
}

function notify(text) {
  toBridge('toast', { text });
}

function log(line) {
  const node = $('log');
  const stamp = new Date().toLocaleTimeString('es-ES', { hour12: false });
  node.textContent = [`${stamp}  ${line}`, node.textContent].filter(Boolean).join('\n');
}

function setProgress(ratio, text) {
  const box = $('progress');
  if (ratio === null) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  $('progressBar').style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
  $('progressText').textContent = text ?? `${Math.round(ratio * 100)} %`;
}

// --- ajustes ----------------------------------------------------------------
function controls() {
  return {
    format: $('format'),
    quality: $('quality'),
    upscaler: $('upscaler'),
    aiModel: $('aiModel'),
    scale: $('scale'),
    targetWidth: $('targetWidth'),
    sharpen: $('sharpen'),
    trimBars: $('trimBars'),
    crop169: $('crop169'),
    gammaCorrect: $('gammaCorrect'),
    zipBatch: $('zipBatch'),
    filenameTemplate: $('filenameTemplate'),
    folderPrefix: $('folderPrefix'),
  };
}

function fillModelSelect() {
  const select = $('aiModel');
  select.textContent = '';
  for (const model of Object.values(AI_MODELS)) {
    const option = document.createElement('option');
    option.value = model.key;
    option.textContent = `${model.label} — ${model.detail}`;
    select.append(option);
  }
}

function settingsFromControls() {
  const c = controls();
  return {
    ...state.settings,
    format: c.format.value,
    quality: Number(c.quality.value) / 100,
    upscaler: c.upscaler.value,
    aiModel: c.aiModel.value,
    scale: Number(c.scale.value),
    targetWidth: Number(c.targetWidth.value),
    sharpen: Number(c.sharpen.value) / 100,
    trimBars: c.trimBars.checked,
    crop169: c.crop169.checked,
    gammaCorrect: c.gammaCorrect.checked,
    zipBatch: c.zipBatch.checked,
    filenameTemplate: c.filenameTemplate.value.trim() || '{title}_{w}x{h}',
    folderPrefix: c.folderPrefix.value,
  };
}

function applySettingsToControls(settings) {
  const c = controls();
  c.format.value = settings.format;
  c.quality.value = String(Math.round(settings.quality * 100));
  c.upscaler.value = settings.upscaler;
  c.aiModel.value = settings.aiModel;
  c.scale.value = String(settings.scale);
  c.targetWidth.value = String(settings.targetWidth);
  c.sharpen.value = String(Math.round(settings.sharpen * 100));
  c.trimBars.checked = Boolean(settings.trimBars);
  c.crop169.checked = Boolean(settings.crop169);
  c.gammaCorrect.checked = settings.gammaCorrect !== false;
  c.zipBatch.checked = Boolean(settings.zipBatch);
  c.filenameTemplate.value = settings.filenameTemplate;
  c.folderPrefix.value = settings.folderPrefix ?? '';
  updateDependentUi();
}

function updateDependentUi() {
  const settings = settingsFromControls();
  $('modelField').classList.toggle('hidden', settings.upscaler !== 'ai');
  $('qualityField').classList.toggle('hidden', settings.format === 'png');
  $('qualityValue').textContent = `${Math.round(settings.quality * 100)} %`;
  $('sharpenValue').textContent = settings.sharpen.toFixed(2);
  $('targetWidthValue').textContent = settings.targetWidth ? `${settings.targetWidth} px` : '∞';

  const info = plan(settings);
  const best = state.video.candidates[0];
  const parts = [];
  if (settings.upscaler === 'ai') {
    parts.push(`${info.model.label.split(' ')[0]} ×${info.native}`);
    if (settings.scale > 0) parts.push(`ajuste a ×${info.factor}`);
  } else if (info.factor !== 1) {
    parts.push(`Lanczos ×${info.factor}`);
  } else {
    parts.push('sin escalar');
  }
  if (best) {
    parts.push(`${best.width}×${best.height} → ${Math.round(best.width * info.factor)}×${Math.round(best.height * info.factor)}`);
  }
  $('summary').textContent = parts.join(' · ');
}

async function persist() {
  state.settings = await saveSettings(settingsFromControls());
  updateDependentUi();
}

function bindControls() {
  for (const element of Object.values(controls())) {
    element.addEventListener('change', persist);
    element.addEventListener('input', () => {
      state.settings = settingsFromControls();
      updateDependentUi();
    });
  }
}

// --- datos ------------------------------------------------------------------
function currentTabItems() {
  return state.tab === 'video' ? state.video.candidates : state.page;
}

function renderTabs() {
  $('countVideo').textContent = String(state.video.candidates.length);
  $('countPage').textContent = String(state.page.length);
}

function renderGrid() {
  const grid = $('grid');
  const items = currentTabItems();
  const selected = state.selection[state.tab];
  grid.textContent = '';

  if (state.video.loading && state.tab === 'video') {
    grid.innerHTML = '<p class="summary">Buscando todas las miniaturas disponibles…</p>';
    return;
  }
  if (!items.length) {
    grid.innerHTML = '<p class="summary">No hay nada que mostrar en esta pestaña.</p>';
    return;
  }

  for (const item of items) {
    const card = document.createElement('article');
    card.className = `card${selected.has(item.key) ? ' selected' : ''}`;
    card.tabIndex = 0;

    const figure = document.createElement('figure');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = item.previewUrl || item.url;
    img.alt = item.label || '';
    figure.append(img);

    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = '✓';

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = item.tag;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.label;
    const size = document.createElement('b');
    size.textContent = item.width && item.height ? `${item.width}×${item.height}` : 'auto';
    meta.append(name, size);

    card.append(figure, tick, tag, meta);
    card.addEventListener('click', (event) => {
      if (event.target === img) openLightbox(item);
      else toggleSelect(item.key);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleSelect(item.key);
      }
    });
    grid.append(card);
  }
}

function toggleSelect(key) {
  const selected = state.selection[state.tab];
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  renderGrid();
  updateFooter();
}

function updateFooter() {
  const count = state.selection[state.tab].size;
  const total = currentTabItems().length;
  $('downloadSelected').textContent = count
    ? `Descargar ${count} seleccionada${count > 1 ? 's' : ''}`
    : 'Descargar seleccionadas';
  $('downloadAll').textContent = total > 1 ? `Descargar todas (${total})` : 'Descargar todas';
  $('downloadSelected').disabled = state.busy || count === 0;
  $('downloadAll').disabled = state.busy || total === 0;
}

async function loadVideoCandidates(videoId, knownTitle = '') {
  state.video.loading = true;
  state.video.title = knownTitle;
  renderGrid();
  const found = await probeCandidates(buildCandidateList(videoId), { limit: 8 });
  state.video.candidates = found.map((item) => ({
    ...item,
    previewUrl: item.url,
    tag: item.groupId,
    fileTitle: state.video.title || videoId,
  }));
  state.video.loading = false;
  renderTabs();
  renderGrid();
  updateFooter();
  updateDependentUi();
  log(`Vídeo ${videoId}: ${found.length} miniaturas. Mejor: ${found[0]?.label ?? '—'}`);
}

async function loadVideoTitle(videoId) {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    if (!response.ok) return;
    const meta = parseMeta(await response.text());
    if (meta.title) {
      state.video.title = meta.title;
      for (const item of state.video.candidates) item.fileTitle = meta.title;
      log(`Título: ${meta.title}`);
    }
  } catch {
    /* el título es opcional */
  }
}

function adoptPageItems(candidates) {
  state.page = (candidates || []).map((item) => ({
    key: item.videoId,
    videoId: item.videoId,
    title: item.title || item.videoId,
    fileTitle: item.title || item.videoId,
    label: item.title || item.videoId,
    previewUrl: item.imageUrl,
    tag: 'página',
    width: 0,
    height: 0,
  }));
}

// --- nombres ----------------------------------------------------------------
function buildFilename(item, result, settings) {
  return buildFilenamePath(item, result, settings, state.video.id);
}

// --- descarga ---------------------------------------------------------------
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, conflictAction: 'uniquify', saveAs: false },
      (id) => {
        setTimeout(() => URL.revokeObjectURL(url), 120000);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      },
    );
  });
}

async function resolveSourceFor(item) {
  if (item.blob) return { blob: item.blob, sourceName: item.name };
  if (item.videoId) {
    const best = (await probeCandidates(buildCandidateList(item.videoId), { limit: 8 }))[0];
    if (!best) throw new Error(`no se encontró ninguna miniatura para ${item.videoId}`);
    return { blob: best.blob, sourceName: best.name };
  }
  const probed = await probeImage(item.url);
  if (!probed) throw new Error('no se pudo descargar la imagen');
  return { blob: probed.blob, sourceName: 'original' };
}

/**
 * El popup de Yumiko ya sabe qué vídeo es y cómo se titula, así que lo pasa con
 * el contexto: el estudio no tiene que adivinarlo ni ir a buscar el título con
 * una petición extra a la página de watch.
 */
function adoptPopupContext(payload) {
  if (payload?.videoId) state.video.id = payload.videoId;
  if (payload?.videoTitle) {
    state.video.title = payload.videoTitle;
    for (const item of state.video.candidates) item.fileTitle = payload.videoTitle;
  }
}

async function runDownload({ onlyBest }) {
  if (state.busy) return;
  const items = currentTabItems();
  if (!items.length) return;
  const list = onlyBest ? items.slice(0, 1) : items.filter((item) => state.selection[state.tab].has(item.key));
  if (!list.length) return;

  const settings = settingsFromControls();
  state.busy = true;
  updateFooter();
  const outputs = [];

  try {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      const { blob, sourceName } = await resolveSourceFor(item);
      const result = await processImage({
        blob,
        settings,
        onStatus: (text) => log(`${item.label}: ${text}`),
        onProgress: ({ phase, ratio, loaded }) => {
          if (phase === 'descargando' || phase === 'modelo' || phase === 'incluido' || phase === 'cache') {
            setProgress(i / list.length, `modelo ${formatBytes(loaded || 0)}`);
          } else if (phase === 'ia') {
            setProgress((i + ratio * 0.9) / list.length, `IA ${Math.round(ratio * 100)} %`);
          }
        },
      });
      setProgress((i + 1) / list.length, `${i + 1}/${list.length}`);
      const filename = buildFilename({ ...item, sourceName }, result, settings);
      outputs.push({ blob: result.blob, filename });
      log(`✓ ${filename} — ${result.sourceWidth}×${result.sourceHeight} → ${result.width}×${result.height} · ${formatBytes(result.blob.size)}`);
    }

    if (outputs.length === 1) {
      await saveBlob(outputs[0].blob, outputs[0].filename);
      notify(`Guardado: ${outputs[0].filename.split('/').pop()}`);
    } else if (settings.zipBatch) {
      const zip = await createZip(outputs.map(({ blob, filename }) => ({ blob, name: filename.split('/').pop() })));
      await saveBlob(zip, buildZipPath(outputs.length, settings.folderPrefix));
      notify(`ZIP con ${outputs.length} imágenes en ${settings.folderPrefix || 'Descargas'}`);
    } else {
      for (const output of outputs) await saveBlob(output.blob, output.filename);
      notify(`${outputs.length} imágenes guardadas`);
    }
  } catch (error) {
    log(`✕ ${error.message}`);
    notify(`Error: ${error.message}`);
  } finally {
    state.busy = false;
    setProgress(null);
    updateFooter();
  }
}

// --- lightbox ---------------------------------------------------------------
function openLightbox(item) {
  $('lightboxImage').src = item.previewUrl || item.url;
  $('lightboxCaption').textContent = [item.label, item.width ? `${item.width}×${item.height}` : '', item.url]
    .filter(Boolean)
    .join('  ·  ');
  $('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lightboxImage').src = '';
}

// --- ciclo de vida ----------------------------------------------------------
async function handleContext(payload) {
  state.context = payload;
  $('panel').style.display = '';
  $('backdrop').style.display = '';
  $('pageSub').textContent = payload.title || payload.href || '';

  // El popup manda el id y el título ya resueltos; si no, se sacan de la URL.
  // El id anterior se guarda ANTES de adoptarlo: si no, la comparación de abajo
  // siempre da igual y las miniaturas no se llegan a buscar.
  const previousId = state.video.id;
  adoptPopupContext(payload);
  const videoId = state.video.id || extractVideoId(payload.href);
  if (videoId && videoId !== previousId) {
    state.video.id = videoId;
    state.selection.video.clear();
    $('pageSub').textContent = `Buscando miniaturas de ${videoId}…`;
    await loadVideoCandidates(videoId, payload?.videoTitle || '');
    // El título solo se busca si nadie lo ha dado.
    if (!state.video.title) loadVideoTitle(videoId);
    // El subtítulo se queda en "Buscando…" si no se actualiza: parece que
    // sigue cargando cuando en realidad ya ha terminado.
    const title = state.video.title || videoId;
    const total = state.video.candidates.length;
    $('pageSub').textContent = total
      ? `${title} · ${total} miniatura${total > 1 ? 's' : ''}`
      : `${title} · YouTube no expone miniaturas de este vídeo`;
  }

  adoptPageItems(payload.candidates);
  renderTabs();
  renderGrid();
  updateFooter();
}

function bindUi() {
  $('closePanel').addEventListener('click', () => toBridge('closed'));
  $('backdrop').addEventListener('click', () => toBridge('closed'));
  $('lightboxClose').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (event) => {
    if (event.target === $('lightbox')) closeLightbox();
  });
  // En Yumiko los ajustes viven aquí mismo, así que el botón solo despliega el
  // bloque avanzado en lugar de abrir una página de opciones.
  $('toggleAdvanced').addEventListener('click', () => {
    const details = document.querySelector('.advanced');
    details.open = !details.open;
    $('toggleAdvanced').classList.toggle('active', details.open);
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      for (const node of document.querySelectorAll('.tab')) node.classList.toggle('active', node === tab);
      renderGrid();
      updateFooter();
      updateDependentUi();
    });
  }

  $('selectBest').addEventListener('click', () => {
    const selected = state.selection[state.tab];
    selected.clear();
    const items = currentTabItems();
    if (items.length) selected.add(items[0].key);
    renderGrid();
    updateFooter();
  });

  $('selectNone').addEventListener('click', () => {
    state.selection[state.tab].clear();
    renderGrid();
    updateFooter();
  });

  $('downloadSelected').addEventListener('click', () => runDownload({ onlyBest: false }));
  $('downloadAll').addEventListener('click', () => runDownload({ onlyBest: true }));

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('lightbox').classList.contains('hidden')) closeLightbox();
  });
}

async function init() {
  fillModelSelect();
  state.settings = await loadSettings();
  applySettingsToControls(state.settings);
  bindControls();
  bindUi();
  renderTabs();
  updateFooter();

  onSettingsChanged((settings) => {
    state.settings = settings;
    applySettingsToControls(settings);
  });

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.ns !== NS) return;
    if (data.type === 'context') handleContext(data.payload);
    if (data.type === 'close') {
      $('panel').style.display = 'none';
      $('backdrop').style.display = 'none';
      closeLightbox();
    }
  });

  toBridge('ready');
}

init();

window.addEventListener('error', (event) => log(`✕ ${event.message}`));
window.addEventListener('unhandledrejection', (event) => log(`✕ ${event.reason?.message || event.reason}`));