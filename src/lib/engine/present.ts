/** How the engine's state reads on the Download page. */
import type { BootStage } from './runtime';
import type { EngineState } from './session.svelte';

/** The boot's steps before it is ready, in order: counted, so a slow one is seen to progress. */
const STEPS = ['runtime', 'wheels', 'yt-dlp'] as const satisfies readonly BootStage[];

export interface EngineStatus {
	text: string;
	/** Whether the engine is still on its way: the page shows a busy sign. */
	busy: boolean;
}

export function engineStatus(
	engine: { state: EngineState; stage: BootStage | null; error: string | null },
	version: string
): EngineStatus {
	if (engine.state === 'failed')
		return { text: `The engine failed to start: ${engine.error}`, busy: false };
	if (engine.state === 'ready') return { text: `yt-dlp ${version} ready`, busy: false };
	const step = STEPS.indexOf(engine.stage as (typeof STEPS)[number]);
	if (step < 0) return { text: 'Starting the engine…', busy: true };
	const doing = {
		runtime: 'Loading the Python runtime',
		wheels: `Installing yt-dlp ${version}`,
		'yt-dlp': 'Starting yt-dlp'
	}[STEPS[step]];
	return { text: `${doing} (step ${step + 1} of ${STEPS.length})…`, busy: true };
}
