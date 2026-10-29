/**
 * An Emscripten filesystem whose files are OPFS sync access handles, so ffmpeg
 * reads its inputs from, and writes its output straight to, origin-private
 * storage: nothing is buffered in memory, whatever the size of the video.
 * (MEMFS would hold the whole output in the worker's heap; WORKERFS is
 * read-only.) Each read and write moves bytes directly between the handle and
 * the wasm heap.
 *
 * A mount holds exactly the files it is given. Creating, renaming or deleting
 * anything in it fails with EPERM, so ffmpeg can touch those files and no
 * others.
 */

/** What ffmpeg's file I/O needs from an OPFS `FileSystemSyncAccessHandle`. */
export interface ByteHandle {
	getSize(): number;
	read(buffer: ArrayBufferView, options: { at: number }): number;
	write(buffer: ArrayBufferView, options: { at: number }): number;
	truncate(size: number): void;
	flush(): void;
}

/** The slice of Emscripten's FS node, stream and module API this uses. */
export interface FsNode {
	id: number;
	name: string;
	mode: number;
	mount?: FsMount;
	node_ops: object;
	stream_ops: object;
	contents?: Record<string, FsNode>;
	handle?: ByteHandle;
	timestamp: number;
}

export interface FsMount {
	mountpoint: string;
	opts: HandleMountOptions;
}

export interface FsStream {
	node: FsNode;
	flags: number;
	position: number;
}

export interface EmscriptenFs {
	createNode(parent: FsNode | null, name: string, mode: number, dev?: number): FsNode;
	isFile(mode: number): boolean;
	ErrnoError: new (errno: number) => Error;
	mkdir(path: string): void;
	rmdir(path: string): void;
	mount(type: HandleFsType, opts: HandleMountOptions, mountpoint: string): FsNode;
	unmount(mountpoint: string): void;
	close(stream: FsStream): void;
	streams: (FsStream | null | undefined)[];
}

export interface HandleMountOptions {
	/** File name → handle. */
	files: Record<string, ByteHandle>;
}

export interface HandleFsType {
	mount(mount: FsMount): FsNode;
}

const DIR_MODE = 0o40555;
const FILE_MODE = 0o100666;
// Emscripten's errno numbering (WASI).
const EPERM = 63;
const EINVAL = 28;
const EIO = 29;
const ENOENT = 44;
const SEEK_CUR = 1;
const SEEK_END = 2;
const ACCESS_MODE = 3; // O_WRONLY | O_RDWR

export function handleFs(FS: EmscriptenFs): HandleFsType {
	const fail = (errno: number) => {
		throw new FS.ErrnoError(errno);
	};
	const sizeOf = (node: FsNode) => (node.handle ? node.handle.getSize() : 4096);

	const node_ops = {
		getattr(node: FsNode) {
			const size = sizeOf(node);
			const time = new Date(node.timestamp);
			return {
				dev: 1,
				ino: node.id,
				mode: node.mode,
				nlink: 1,
				uid: 0,
				gid: 0,
				rdev: 0,
				size,
				atime: time,
				mtime: time,
				ctime: time,
				blksize: 4096,
				blocks: Math.ceil(size / 4096)
			};
		},
		setattr(node: FsNode, attr: { size?: number; timestamp?: number }) {
			if (attr.size !== undefined) {
				if (!node.handle) fail(EPERM);
				node.handle!.truncate(attr.size);
			}
			if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
		},
		// Every file exists from the moment of mounting; anything else does not.
		lookup: () => fail(ENOENT),
		mknod: () => fail(EPERM),
		rename: () => fail(EPERM),
		unlink: () => fail(EPERM),
		rmdir: () => fail(EPERM),
		symlink: () => fail(EPERM),
		readdir: (node: FsNode) => ['.', '..', ...Object.keys(node.contents ?? {})]
	};

	const stream_ops = {
		read(stream: FsStream, buffer: Uint8Array, offset: number, length: number, position: number) {
			return stream.node.handle!.read(buffer.subarray(offset, offset + length), { at: position });
		},
		write(stream: FsStream, buffer: Uint8Array, offset: number, length: number, position: number) {
			const written = stream.node.handle!.write(buffer.subarray(offset, offset + length), {
				at: position
			});
			if (written !== length) fail(EIO);
			return written;
		},
		llseek(stream: FsStream, offset: number, whence: number) {
			let position = offset;
			if (whence === SEEK_CUR) position += stream.position;
			else if (whence === SEEK_END) position += sizeOf(stream.node);
			if (position < 0) fail(EINVAL);
			return position;
		},
		close(stream: FsStream) {
			if (stream.flags & ACCESS_MODE) stream.node.handle!.flush();
		}
	};

	const createNode = (parent: FsNode | null, name: string, mode: number, handle?: ByteHandle) => {
		const node = FS.createNode(parent, name, mode);
		node.node_ops = node_ops;
		node.stream_ops = stream_ops;
		node.timestamp = Date.now();
		if (handle) node.handle = handle;
		else node.contents = {};
		if (parent) parent.contents![name] = node;
		return node;
	};

	return {
		mount(mount) {
			const root = createNode(null, '/', DIR_MODE);
			// Set before the files exist, so they belong to this mount and
			// unmounting forgets them.
			root.mount = mount;
			for (const [name, handle] of Object.entries(mount.opts.files)) {
				if (!name || name.includes('/') || name === '.' || name === '..') fail(EINVAL);
				createNode(root, name, FILE_MODE, handle);
			}
			return root;
		}
	};
}

/**
 * Mount `files` at `mountpoint` for the duration of `use`, then unmount —
 * closing any stream ffmpeg left open, so no descriptor outlives the handles.
 */
export function withHandles<T>(
	FS: EmscriptenFs,
	mountpoint: string,
	files: Record<string, ByteHandle>,
	use: () => T
): T {
	FS.mkdir(mountpoint);
	try {
		FS.mount(handleFs(FS), { files }, mountpoint);
		try {
			return use();
		} finally {
			for (const stream of FS.streams) {
				if (stream && stream.node.mount?.mountpoint === mountpoint) FS.close(stream);
			}
			FS.unmount(mountpoint);
		}
	} finally {
		FS.rmdir(mountpoint);
	}
}
