/**
 * Documento offscreen: solo se usa para
 *   - mantener despierto al service worker durante los trabajos largos;
 *   - reensamblar en un solo blob los bytes que copia la página, por si el
 *     navegador no acepta guardar directamente su blob.
 */

const chunks = new Map();
const heartbeat = setInterval(() => {
	chrome.runtime.sendMessage({ type: 'yumiko:ping' }).catch(() => {});
}, 20000);
heartbeat.unref?.();

const decode = async (base64) => {
	const response = await fetch(`data:application/octet-stream;base64,${base64}`);
	return new Uint8Array(await response.arrayBuffer());
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	const { type, session } = message || {};

	if (type === 'yumiko:assemble-start') {
		chunks.set(session, { parts: [], mimeType: message.mimeType || 'application/octet-stream' });
		sendResponse({ ok: true });
		return false;
	}

	if (type === 'yumiko:assemble-chunk') {
		const entry = chunks.get(session);
		if (!entry) {
			sendResponse({ ok: false, error: 'No hay ninguna transferencia en curso.' });
			return false;
		}
		decode(message.data)
			.then((bytes) => {
				entry.parts.push(bytes);
				sendResponse({ ok: true, parts: entry.parts.length });
			})
			.catch((error) => sendResponse({ ok: false, error: error.message }));
		return true;
	}

	if (type === 'yumiko:assemble-end') {
		const entry = chunks.get(session);
		chunks.delete(session);
		if (!entry) {
			sendResponse({ ok: false, error: 'No hay ninguna transferencia en curso.' });
			return false;
		}
		const blob = new Blob(entry.parts, { type: entry.mimeType });
		sendResponse({ ok: true, url: URL.createObjectURL(blob), size: blob.size });
		return false;
	}

	if (type === 'yumiko:ping') return false;

	return false;
});