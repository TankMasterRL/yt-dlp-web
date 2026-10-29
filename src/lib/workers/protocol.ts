/**
 * The postMessage protocol every worker in this app speaks (engine, download,
 * remux, animate) — the same shape as LiveTranslate-WebGPU's workers:
 *
 *   → load                          ← progress* then ready | error (no id)
 *   → work {id}                     ← progress {id}* then result {id} | error {id}
 *
 * Clients match results to promises by id. A load failure is an `error` with no
 * id and MUST reject the pending load() — a worker that dies while booting must
 * never leave the UI waiting forever.
 */
export type ToWorker<L, Q> =
	{ type: 'load'; payload: L } | { type: 'work'; id: number; payload: Q };

export type FromWorker<R, P> =
	| { type: 'progress'; id?: number; payload: P }
	| { type: 'ready' }
	| { type: 'result'; id: number; payload: R }
	| { type: 'error'; id?: number; message: string; name?: string };

/** The subset of Worker / MessagePort both ends need. */
export interface Endpoint {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface WorkerHandlers<L, Q, R, P> {
	load(payload: L, progress: (p: P) => void): Promise<void>;
	work(payload: Q, progress: (p: P) => void): Promise<R> | R;
}

/** Worker side: dispatch protocol messages to handlers. */
export function serveWorker<L, Q, R, P>(
	handlers: WorkerHandlers<L, Q, R, P>,
	endpoint: Endpoint = self as unknown as Endpoint
): void {
	const send = (message: FromWorker<R, P>) => endpoint.postMessage(message);
	endpoint.addEventListener('message', async (event: MessageEvent<ToWorker<L, Q>>) => {
		const message = event.data;
		if (message.type === 'load') {
			try {
				await handlers.load(message.payload, (payload) => send({ type: 'progress', payload }));
				send({ type: 'ready' });
			} catch (e) {
				send({ type: 'error', message: errorMessage(e), name: errorName(e) });
			}
			return;
		}
		const { id } = message;
		try {
			const payload = await handlers.work(message.payload, (p) =>
				send({ type: 'progress', id, payload: p })
			);
			send({ type: 'result', id, payload });
		} catch (e) {
			send({ type: 'error', id, message: errorMessage(e), name: errorName(e) });
		}
	});
}

/** Main-thread side. */
export class WorkerClient<L, Q, R, P> {
	#endpoint: Endpoint & { terminate?: () => void };
	#nextId = 1;
	#pending = new Map<number, { resolve: (r: R) => void; reject: (e: Error) => void }>();
	#load?: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void };
	#terminated?: Error;

	constructor(
		endpoint: Endpoint & { terminate?: () => void },
		private readonly onProgress: (progress: P, id?: number) => void = () => {}
	) {
		this.#endpoint = endpoint;
		endpoint.addEventListener('message', (event: MessageEvent<FromWorker<R, P>>) =>
			this.#receive(event.data)
		);
	}

	/** Start loading; idempotent. Calls made meanwhile wait for it. */
	load(payload: L): Promise<void> {
		if (!this.#load) {
			let resolve!: () => void;
			let reject!: (e: Error) => void;
			const promise = new Promise<void>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			this.#load = { promise, resolve, reject };
			this.#endpoint.postMessage({ type: 'load', payload } satisfies ToWorker<L, Q>);
		}
		return this.#load.promise;
	}

	async call(payload: Q, transfer: Transferable[] = []): Promise<R> {
		if (!this.#load) throw new Error('call() before load()');
		await this.#load.promise;
		// terminate() may have run while this call was waiting for load().
		if (this.#terminated) throw this.#terminated;
		const id = this.#nextId++;
		return new Promise<R>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#endpoint.postMessage({ type: 'work', id, payload } satisfies ToWorker<L, Q>, transfer);
		});
	}

	terminate(reason = new Error('worker terminated')): void {
		this.#terminated = reason;
		this.#endpoint.terminate?.();
		this.#load?.reject(reason);
		for (const { reject } of this.#pending.values()) reject(reason);
		this.#pending.clear();
	}

	#receive(message: FromWorker<R, P>): void {
		switch (message.type) {
			case 'progress':
				this.onProgress(message.payload, message.id);
				break;
			case 'ready':
				this.#load?.resolve();
				break;
			case 'result':
				this.#settle(message.id)?.resolve(message.payload);
				break;
			case 'error': {
				// Errors cross the boundary as data; keep the name (AbortError vs a real failure).
				const error = new Error(message.message);
				if (message.name) error.name = message.name;
				if (message.id === undefined) this.#load?.reject(error);
				else this.#settle(message.id)?.reject(error);
				break;
			}
		}
	}

	#settle(id: number) {
		const entry = this.#pending.get(id);
		this.#pending.delete(id);
		return entry;
	}
}

function errorMessage(e: unknown): string {
	return e instanceof Error || e instanceof DOMException ? e.message : String(e);
}

function errorName(e: unknown): string | undefined {
	return e instanceof Error || e instanceof DOMException ? e.name : undefined;
}
