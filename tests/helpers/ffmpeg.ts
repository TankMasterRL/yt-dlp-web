/**
 * The REAL ffmpeg.wasm core (`@ffmpeg/core`, the build the app serves), booted
 * in Node for integration tests, plus an in-memory stand-in for an OPFS sync
 * access handle.
 */
import { readFileSync } from 'node:fs';
import type { EmscriptenFs, ByteHandle } from '../../src/lib/remux/handle-fs';
import type { FFmpegCore } from '../../src/lib/remux/merge';

const DIST = new URL('../../node_modules/@ffmpeg/core/dist/esm/', import.meta.url);

export interface NodeFFmpegCore extends FFmpegCore {
	FS: EmscriptenFs & {
		writeFile(path: string, data: Uint8Array): void;
		readFile(path: string): Uint8Array;
		readdir(path: string): string[];
		unlink(path: string): void;
	};
	ffprobe(...args: string[]): number;
}

export async function loadFFmpegCore(): Promise<NodeFFmpegCore> {
	// The ESM build targets workers only: it reads self.location while starting.
	const global = globalThis as { self?: unknown; location?: unknown };
	global.self ??= globalThis;
	global.location ??= { href: new URL('ffmpeg-core.js', DIST).href };
	const { default: createFFmpegCore } = await import(
		/* @vite-ignore */ new URL('ffmpeg-core.js', DIST).href
	);
	// Hand it the wasm bytes: Node's fetch cannot read file: URLs.
	return createFFmpegCore({ wasmBinary: readFileSync(new URL('ffmpeg-core.wasm', DIST)) });
}

/** A growable byte file with the read/write/truncate semantics of `FileSystemSyncAccessHandle`. */
export class MemoryHandle implements ByteHandle {
	#bytes: Uint8Array;
	#size: number;
	flushes = 0;

	constructor(initial: Uint8Array = new Uint8Array()) {
		this.#bytes = new Uint8Array(initial);
		this.#size = initial.byteLength;
	}

	get bytes(): Uint8Array {
		return this.#bytes.slice(0, this.#size);
	}

	getSize(): number {
		return this.#size;
	}

	read(buffer: ArrayBufferView, { at }: { at: number }): number {
		const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		const n = Math.max(0, Math.min(target.byteLength, this.#size - at));
		target.set(this.#bytes.subarray(at, at + n));
		return n;
	}

	write(buffer: ArrayBufferView, { at }: { at: number }): number {
		const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		this.#reserve(at + source.byteLength);
		// Writing past the end leaves a zero-filled gap.
		if (at > this.#size) this.#bytes.fill(0, this.#size, at);
		this.#bytes.set(source, at);
		this.#size = Math.max(this.#size, at + source.byteLength);
		return source.byteLength;
	}

	truncate(size: number): void {
		this.#reserve(size);
		// Growing zero-fills, like OPFS; shrinking forgets the tail.
		if (size > this.#size) this.#bytes.fill(0, this.#size, size);
		this.#size = size;
	}

	flush(): void {
		this.flushes++;
	}

	#reserve(size: number) {
		if (size <= this.#bytes.byteLength) return;
		const grown = new Uint8Array(Math.max(size, this.#bytes.byteLength * 2));
		grown.set(this.#bytes.subarray(0, this.#size));
		this.#bytes = grown;
	}
}
