// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { engineStatus } from './present';

const status = (
	state: Parameters<typeof engineStatus>[0]['state'],
	stage: Parameters<typeof engineStatus>[0]['stage'] = null,
	error: string | null = null
) => engineStatus({ state, stage, error }, '2026.10.26');

describe('engineStatus', () => {
	it('counts the steps of a boot, so a long one is seen to be going somewhere', () => {
		expect(status('booting', 'runtime')).toEqual({
			text: 'Loading the Python runtime (step 1 of 3)…',
			busy: true
		});
		expect(status('booting', 'wheels')).toEqual({
			text: 'Installing yt-dlp 2026.10.26 (step 2 of 3)…',
			busy: true
		});
		expect(status('booting', 'yt-dlp')).toEqual({
			text: 'Starting yt-dlp (step 3 of 3)…',
			busy: true
		});
	});

	it('is busy from the moment the page asks for an engine', () => {
		expect(status('idle')).toEqual({ text: 'Starting the engine…', busy: true });
		expect(status('booting')).toEqual({ text: 'Starting the engine…', busy: true });
	});

	it('says which yt-dlp is ready, or why there is none', () => {
		expect(status('ready', 'ready')).toEqual({ text: 'yt-dlp 2026.10.26 ready', busy: false });
		expect(status('failed', 'runtime', 'pyodide.asm.wasm: HTTP 404')).toEqual({
			text: 'The engine failed to start: pyodide.asm.wasm: HTTP 404',
			busy: false
		});
	});
});
