/**
 * Copy a file the person picked on their device into a byte sink: the import
 * half of the download worker, which wires it to an OPFS sync access handle.
 * A File handed to a worker is a reference to the bytes on disk, never a copy
 * of them in memory, so this reads it a slice at a time.
 */
import type { ByteSink, DownloadProgress } from './download';

/** Big enough to be efficient, small enough to hold in memory twice over. */
export const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;

export async function copyToSink(
	source: Blob,
	sink: ByteSink,
	options: {
		chunkBytes?: number;
		signal?: AbortSignal;
		onProgress?: (progress: DownloadProgress) => void;
	} = {}
): Promise<{ bytesTotal: number }> {
	const { chunkBytes = IMPORT_CHUNK_BYTES, signal, onProgress = () => {} } = options;
	const total = source.size;
	// An import never resumes: whatever an interrupted one left is started over.
	sink.truncate(0);
	for (let offset = 0; offset < total;) {
		signal?.throwIfAborted();
		const bytes = new Uint8Array(await source.slice(offset, offset + chunkBytes).arrayBuffer());
		// A file that shrank on disk after it was picked.
		if (!bytes.byteLength) throw new Error('The file changed while it was being imported');
		sink.write(bytes, offset);
		offset += bytes.byteLength;
		onProgress({ bytesDone: offset, bytesTotal: total });
	}
	sink.flush();
	return { bytesTotal: total };
}
