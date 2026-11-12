/**
 * The tab's one extraction session, wired to the engine worker. It outlives
 * the Download page: leaving for the library and coming back finds Pyodide
 * and yt-dlp still booted, and the formats last found still listed, instead
 * of loading the runtime again. The worker goes when the tab does.
 * Browser-only — pages call it from their scripts.
 */
import { spawnEngine, type EngineLoad } from './client';
import { ExtractSession } from './session.svelte';

let session: ExtractSession | undefined;

export function getSession(load: EngineLoad): ExtractSession {
	session ??= new ExtractSession(spawnEngine, load);
	return session;
}
