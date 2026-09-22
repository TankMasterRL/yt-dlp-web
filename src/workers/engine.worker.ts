/**
 * The engine worker: Pyodide + yt-dlp, off the main thread.
 *
 * Python's I/O is synchronous XHR to the relay — legal only in a Worker. Pyodide
 * and the pinned wheels are loaded from this app's own origin; the wheels are
 * SHA-256 checked before they are unpacked (bootEngine).
 */
import type { EngineLoad, EngineProgress, EngineRequest } from '$lib/engine/client';
import { bootEngine, type Engine, type ExtractResult } from '$lib/engine/runtime';
import { createSyncTransport } from '$lib/relay/client';
import { serveWorker } from '$lib/workers/protocol';

let engine: Engine | undefined;

serveWorker<EngineLoad, EngineRequest, ExtractResult, EngineProgress>({
	async load({ assetsBase, relayEndpoint }, progress) {
		const indexURL = new URL('pyodide/', assetsBase).href;
		// Loaded at runtime from static/pyodide/, not bundled: Pyodide locates its
		// wasm and stdlib relative to its own URL.
		const { loadPyodide } = (await import(
			/* @vite-ignore */ `${indexURL}pyodide.mjs`
		)) as typeof import('pyodide');
		engine = await bootEngine({
			loadPyodide: () => loadPyodide({ indexURL }),
			readWheel: async (pin) => {
				const response = await fetch(new URL(`wheels/${pin.file}`, assetsBase));
				if (!response.ok) throw new Error(`Could not fetch ${pin.file}: HTTP ${response.status}`);
				return response.arrayBuffer();
			},
			transport: createSyncTransport(relayEndpoint),
			onProgress: (stage) => progress({ kind: 'boot', stage })
		});
	},
	work({ url, options }, progress) {
		if (!engine) throw new Error('The engine is not loaded');
		return engine.extract(url, options, (level, line) => progress({ kind: 'log', level, line }));
	}
});
