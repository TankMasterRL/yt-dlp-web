/**
 * Reactive state for the Download page: engine lifecycle, the streaming
 * yt-dlp log, and the latest extraction result. The engine is injected
 * (`spawnEngine` in the app, a fake in tests).
 */
import type { EngineClient, EngineLoad, EngineProgress } from './client';
import type { BootStage, ExtractResult, LogLevel } from './runtime';

export interface LogLine {
	level: LogLevel;
	line: string;
}

export type EngineHandle = Pick<EngineClient, 'load' | 'call' | 'terminate'>;
export type SpawnEngine = (onProgress: (progress: EngineProgress, id?: number) => void) => EngineHandle;
export type EngineState = 'idle' | 'booting' | 'ready' | 'failed';

/** A bare YouTube video id, which yt-dlp accepts in place of a URL. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** An http(s) URL (scheme optional) or a bare video id; anything else is refused. */
export function normalizeInput(raw: string): string | null {
	const input = raw.trim();
	if (!input) return null;
	if (VIDEO_ID.test(input)) return input;
	const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input);
	if (!hasScheme && /\s/.test(input)) return null;
	try {
		const url = new URL(hasScheme ? input : `https://${input}`);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

export class ExtractSession {
	engineState = $state<EngineState>('idle');
	bootStage = $state<BootStage | null>(null);
	engineError = $state<string | null>(null);
	/** Can this deployment solve YouTube's JS challenges? null until the engine says. */
	solverAvailable = $state<boolean | null>(null);
	busy = $state(false);
	inputError = $state<string | null>(null);
	log = $state<LogLine[]>([]);
	result = $state<ExtractResult | null>(null);

	#spawn: SpawnEngine;
	#load: EngineLoad;
	#engine: EngineHandle | null = null;
	#booting: Promise<void> | null = null;

	constructor(spawn: SpawnEngine, load: EngineLoad) {
		this.#spawn = spawn;
		this.#load = load;
	}

	/** Start the engine; idempotent. */
	boot(): Promise<void> {
		if (!this.#booting) {
			this.engineState = 'booting';
			const engine = this.#spawn((progress) => this.#onProgress(progress));
			this.#engine = engine;
			this.#booting = engine.load(this.#load).then(
				() => {
					this.engineState = 'ready';
				},
				(e: Error) => {
					this.engineState = 'failed';
					this.engineError = e.message;
					throw e;
				}
			);
		}
		return this.#booting;
	}

	async extract(rawInput: string): Promise<void> {
		const url = normalizeInput(rawInput);
		if (!url) {
			this.inputError = 'Enter a video URL (http or https).';
			return;
		}
		this.inputError = null;
		this.busy = true;
		this.log = [];
		this.result = null;
		try {
			await this.boot();
			this.result = await this.#engine!.call({ url });
		} catch (e) {
			this.result = { ok: false, error: (e as Error).message, warnings: [] };
		} finally {
			this.busy = false;
		}
	}

	dispose(): void {
		this.#engine?.terminate();
	}

	#onProgress(progress: EngineProgress): void {
		if (progress.kind === 'boot') this.bootStage = progress.stage;
		else if (progress.kind === 'capabilities') this.solverAvailable = progress.solver;
		else this.log.push({ level: progress.level, line: progress.line });
	}
}
