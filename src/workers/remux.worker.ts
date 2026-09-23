/**
 * The remux worker: FFmpeg merges a download's video and audio parts — the
 * core the build ships, ffmpeg.wasm or the remux core (scripts/build-ffmpeg.ts).
 *
 * Opt-in and lazy: the single-threaded core (no SharedArrayBuffer, so no
 * cross-origin isolation) is fetched from this app's own origin only when a
 * merge starts. ffmpeg reads the parts from, and writes the result to, OPFS
 * through sync access handles (handle-fs.ts) — nothing is held in memory, and
 * those three files are all it can touch. Like the download worker, it holds
 * the item's Web Lock throughout.
 */
import { downloadLockName } from '$lib/download/locks';
import { FFMPEG_CORE_JS, FFMPEG_CORE_WASM, FFMPEG_DIR } from '$lib/remux/assets';
import type { RemuxLoad, RemuxWork } from '$lib/remux/client';
import type { ByteHandle } from '$lib/remux/handle-fs';
import { mergeStreams, type FFmpegCore } from '$lib/remux/merge';
import { serveWorker } from '$lib/workers/protocol';

/** The OPFS sync access handle, which TypeScript's DOM lib does not describe. */
interface SyncAccessHandle extends ByteHandle {
	close(): void;
}

let core: FFmpegCore | undefined;

async function openHandle(
	root: FileSystemDirectoryHandle,
	name: string,
	create = false
): Promise<SyncAccessHandle> {
	const file = await root.getFileHandle(name, { create });
	return (
		file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }
	).createSyncAccessHandle();
}

serveWorker<RemuxLoad, RemuxWork, { bytesTotal: number }, never>({
	async load({ assetsBase }) {
		const coreURL = new URL(FFMPEG_DIR + FFMPEG_CORE_JS, assetsBase).href;
		const wasmURL = new URL(FFMPEG_DIR + FFMPEG_CORE_WASM, assetsBase).href;
		// Loaded at runtime from static/ffmpeg/, never bundled.
		const { default: createFFmpegCore } = (await import(/* @vite-ignore */ coreURL)) as {
			default: (options: { mainScriptUrlOrBlob: string }) => Promise<FFmpegCore>;
		};
		// ffmpeg.wasm finds its wasm through this fragment (as @ffmpeg/ffmpeg passes
		// it); the remux core ignores it and loads the ffmpeg-core.wasm beside it.
		core = await createFFmpegCore({
			mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL: '' }))}`
		});
	},
	async work({ request: { itemId, video, audio, output, container } }) {
		if (!core) throw new Error('ffmpeg is not loaded');
		const ffmpeg = core;
		return navigator.locks.request(
			downloadLockName(itemId),
			{ ifAvailable: true },
			async (lock) => {
				if (!lock) throw new Error('This item is busy in another tab');
				const root = await navigator.storage.getDirectory();
				const handles: SyncAccessHandle[] = [];
				const open = async (name: string, create?: boolean) => {
					const handle = await openHandle(root, name, create);
					handles.push(handle);
					return handle;
				};
				let merged = false;
				try {
					const files = {
						video: await open(video),
						audio: await open(audio),
						output: await open(output, true)
					};
					const bytesTotal = mergeStreams(ffmpeg, files, container);
					merged = true;
					return { bytesTotal };
				} finally {
					for (const handle of handles) handle.close();
					// A half-written output is worth nothing; the parts stay for a retry.
					if (!merged) await root.removeEntry(output).catch(() => {});
				}
			}
		);
	}
});
