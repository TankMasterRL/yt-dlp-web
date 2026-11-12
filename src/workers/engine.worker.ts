/**
 * The engine worker: Pyodide + yt-dlp, off the main thread.
 *
 * Python's I/O is synchronous XHR to the relay — legal only in a Worker. Pyodide
 * and the pinned wheels are loaded from this app's own origin; the wheels are
 * SHA-256 checked before they are unpacked (bootEngine).
 */
import type { EngineLoad, EngineProgress, EngineRequest } from '$lib/engine/client';
import { bootEngine, type Engine, type ExtractResult } from '$lib/engine/runtime';
import { createSyncSolver, createSyncTransport, probeRelay } from '$lib/relay/client';
import { serveWorker } from '$lib/workers/protocol';

let engine: Engine | undefined;

// Pyodide tells classic workers from module workers by calling
// importScripts('data:…'), which throws in a module worker either way. WebKit
// checks Trusted Types first, so under this worker's CSP (trusted-types 'none')
// the probe is also reported as a violation. Fail it the same way, without
// reaching the sink: module workers never load classic scripts.
Object.defineProperty(globalThis, 'importScripts', {
	configurable: true,
	value: () => {
		throw new TypeError('Module scripts do not support importScripts().');
	}
});

/**
 * Once the page has heard the engine is ready, the worker's idle moments do a
 * first extraction's one-time work (seconds of it; tens in Firefox), one slice
 * per task: an extraction asked for meanwhile runs after the slice under way,
 * not after the whole warm-up, and finds the rest of it done.
 */
function warmUp(step: () => boolean): void {
	const slice = () => {
		try {
			if (step()) setTimeout(slice);
		} catch {
			// A nicety: an extraction does this work itself when it must.
		}
	};
	setTimeout(slice);
}

serveWorker<EngineLoad, EngineRequest, ExtractResult, EngineProgress>({
	async load({ assetsBase, relayEndpoint, solveEndpoint }, progress) {
		// Probed once: SandboxJCP.is_available() must not touch the network, and
		// yt-dlp picks YouTube clients that need no solving when it is unavailable.
		// A relay that does not answer at all is reported too (the page says so),
		// but the engine still starts: the Worker may come back. The probe runs
		// while Pyodide and the wheels load; only installing yt-dlp waits for it.
		const relay = probeRelay(solveEndpoint).then((relay) => {
			progress({ kind: 'capabilities', relay });
			return relay;
		});
		const indexURL = new URL('pyodide/', assetsBase).href;
		engine = await bootEngine({
			async loadPyodide() {
				// Loaded at runtime from static/pyodide/, not bundled: Pyodide locates its
				// wasm and stdlib relative to its own URL.
				const { loadPyodide } = (await import(
					/* @vite-ignore */ `${indexURL}pyodide.mjs`
				)) as typeof import('pyodide');
				return loadPyodide({ indexURL });
			},
			readWheel: async (pin) => {
				const response = await fetch(new URL(`wheels/${pin.file}`, assetsBase));
				if (!response.ok) throw new Error(`Could not fetch ${pin.file}: HTTP ${response.status}`);
				return response.arrayBuffer();
			},
			transport: createSyncTransport(relayEndpoint),
			solver: relay.then((relay) =>
				relay === 'solves' ? createSyncSolver(solveEndpoint) : undefined
			),
			onProgress: (stage) => progress({ kind: 'boot', stage })
		});
		warmUp(engine.warmUp());
	},
	work({ url, options }, progress) {
		if (!engine) throw new Error('The engine is not loaded');
		return engine.extract(url, options, (level, line) => progress({ kind: 'log', level, line }));
	}
});
