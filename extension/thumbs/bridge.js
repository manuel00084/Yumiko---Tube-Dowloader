/* Puente entre la página de YouTube y el estudio de la extensión.
   No es un módulo: se carga como script clásico de content script. */
(() => {
  if (window.__yumikoThumbsBridge__) return;
  window.__yumikoThumbsBridge__ = true;

  const NS = 'yumiko-thumbs';
  const IDLE = 'yumiko-thumbs-idle';
  const ACTIVE = 'yumiko-thumbs-active';

  let iframe = null;
  let ready = false;
  let queue = [];
  let settings = null;
  let floatingButton = null;

  function post(type, payload = {}) {
    const message = { ns: NS, type, payload };
    if (!ready) {
      queue.push(message);
      return;
    }
    iframe?.contentWindow?.postMessage(message, '*');
  }

  function buildContext() {
    const candidates = collectPageThumbnails();
    return {
      href: location.href,
      title: document.title,
      candidates: settings?.probePageImages === false ? [] : candidates,
    };
  }

  function collectPageThumbnails() {
    const found = new Map();
    const videoLink = 'a[href*="/watch?v="], a[href*="/shorts/"], a[href*="/live/"]';
    const links = document.querySelectorAll(videoLink);
    const max = settings?.maxPageImages ?? 200;
    for (const link of links) {
      if (found.size >= max) break;
      const href = link.getAttribute('href') || '';
      const id = extractId(href);
      if (!id || found.has(id)) continue;
      const title =
        link.getAttribute('title') ||
        link.getAttribute('aria-label') ||
        link.textContent?.trim().slice(0, 160) ||
        id;
      const image = link.querySelector('img')?.currentSrc || link.querySelector('img')?.src || '';
      found.set(id, {
        key: id,
        videoId: id,
        title: title.replace(/\s+/g, ' ').trim(),
        href: new URL(href, location.origin).href,
        imageUrl: image || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      });
    }
    return [...found.values()];
  }

  function extractId(href) {
    if (!href) return null;
    let match = href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (match) return match[1];
    match = href.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  function ensureIframe() {
    if (iframe && iframe.isConnected) return;
    iframe = document.createElement('iframe');
    iframe.id = ACTIVE;
    iframe.src = chrome.runtime.getURL('thumbs/app/studio.html');
    iframe.title = 'Miniaturas de YouTube';
    Object.assign(iframe.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      border: '0',
      margin: '0',
      padding: '0',
      zIndex: '2147483647',
      background: 'transparent',
      colorScheme: 'dark',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 140ms ease',
    });
    (document.body || document.documentElement).appendChild(iframe);
  }

  function showStudio(payload) {
    ensureIframe();
    post('context', payload);
    iframe.style.pointerEvents = 'auto';
    iframe.style.opacity = '1';
    iframe.id = ACTIVE;
  }

  function hideStudio() {
    if (!iframe) return;
    iframe.style.pointerEvents = 'none';
    iframe.style.opacity = '0';
    iframe.id = IDLE;
    post('close');
  }

  function toggleStudio() {
    if (iframe?.id === ACTIVE) hideStudio();
    else showStudio(buildContext());
  }

  window.addEventListener('message', (event) => {
    if (event.source !== iframe?.contentWindow) return;
    const data = event.data;
    if (!data || data.ns !== NS) return;
    if (data.type === 'ready') {
      ready = true;
      for (const message of queue.splice(0)) iframe.contentWindow.postMessage(message, '*');
    }
    if (data.type === 'closed') hideStudio();
    if (data.type === 'toast') showToast(data.payload?.text || '');
  });

  let toastTimer = null;
  function showToast(text) {
    if (!text) return;
    let node = document.getElementById('yumiko-thumbs-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'yumiko-thumbs-toast';
      Object.assign(node.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483646',
        maxWidth: '340px',
        padding: '10px 14px',
        borderRadius: '10px',
        background: 'rgba(15,17,21,0.94)',
        color: '#f2f4f8',
        font: '500 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif',
        boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.12)',
        pointerEvents: 'none',
        transition: 'opacity 180ms ease',
      });
      (document.body || document.documentElement).appendChild(node);
    }
    node.textContent = text;
    node.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.style.opacity = '0';
    }, 3200);
  }

  function mountFloatingButton() {
    if (floatingButton || settings?.showFloatingButton === false) return;
    floatingButton = document.createElement('button');
    floatingButton.id = 'yumiko-thumbs-fab';
    floatingButton.type = 'button';
    floatingButton.title = 'Miniaturas de este vídeo (Alt+M)';
    Object.assign(floatingButton.style, {
      position: 'fixed',
      right: '18px',
      bottom: '90px',
      zIndex: '2147483645',
      width: '46px',
      height: '46px',
      borderRadius: '50%',
      border: '1px solid rgba(255,255,255,0.18)',
      background: 'linear-gradient(140deg, #ff3d3d, #c81d1d)',
      color: '#fff',
      font: '700 18px/1 system-ui, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 8px 22px rgba(0,0,0,0.38)',
      display: 'grid',
      placeItems: 'center',
    });
    floatingButton.textContent = '⇩';
    floatingButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleStudio();
    });
    (document.body || document.documentElement).appendChild(floatingButton);
  }

  async function syncSettings() {
    const stored = await chrome.storage.local.get('yumikoThumbs.settings');
    settings = stored['yumikoThumbs.settings'] || null;
    if (settings?.showFloatingButton === false && floatingButton) {
      floatingButton.remove();
      floatingButton = null;
    } else {
      mountFloatingButton();
    }
  }

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey && (event.key === 'm' || event.key === 'M')) {
        event.preventDefault();
        toggleStudio();
      }
      if (event.key === 'Escape' && iframe?.id === ACTIVE) hideStudio();
    },
    true,
  );

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.ns !== NS) return;
    if (message.type === 'open') showStudio({ ...buildContext(), ...(message.payload || {}) });
    if (message.type === 'refresh-settings') syncSettings();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['yumikoThumbs.settings']) {
      settings = changes['yumikoThumbs.settings'].newValue || settings;
    }
  });

  syncSettings();
})();