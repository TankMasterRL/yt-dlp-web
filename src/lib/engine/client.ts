/**
 * Main-thread handle on the engine worker (src/workers/engine.worker.ts), which
 * hosts Pyodide + yt-dlp. Its synchronous XHR and its ~15 MB runtime never touch
 * the page's thread.
 */
import engineWorkerUrl from '../../workers/engine.worker.ts?worker&url';
import { trustedWorkerUrl } from '$lib/trusted-types';
import { WorkerClient } from '$lib/workers/protocol';
import type { BootStage, ExtractResult, LogLevel } from './runtime';

export interface EngineLoad {
	/** Absolute URL of the app's base: pyodide/ and wheels/ live under it. */
	assetsBase: string;
	/** Absolute URL of the relay endpoint. */
	relayEndpoint: string;
}

export interface EngineRequest {
	url: string;
	options?: Record<string, unknown>;
}

export type EngineProgress =
	| { kind: 'boot'; stage: BootStage }
	| { kind: 'log'; level: LogLevel; line: string };

export type EngineClient = WorkerClient<EngineLoad, EngineRequest, ExtractResult, EngineProgress>;

export function spawnEngine(onProgress: (progress: EngineProgress, id?: number) => void): EngineClient {
	const worker = new Worker(trustedWorkerUrl(engineWorkerUrl), {
		type: 'module',
		name: 'yt-dlp engine'
	});
	return new WorkerClient(worker, onProgress);
}
