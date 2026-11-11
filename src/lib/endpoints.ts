/**
 * Absolute URLs the app talks to, resolved in the browser. Imports $app/paths,
 * so only pages may use it — never a module a node-environment test reaches.
 */
import { base } from '$app/paths';
import { relayEndpoints } from '$lib/relay/client';

export interface AppEndpoints {
	/** pyodide/, wheels/ and ffmpeg/ live under it. */
	assetsBase: string;
	/** The relay Worker's endpoints; null in a build without one (VITE_RELAY_URL=none). */
	relay: { relay: string; solve: string } | null;
}

export function appEndpoints(): AppEndpoints {
	const relay = relayEndpoints(import.meta.env.VITE_RELAY_URL);
	return {
		assetsBase: new URL(`${base}/`, location.href).href,
		relay: relay && {
			relay: new URL(relay.relay, location.href).href,
			solve: new URL(relay.solve, location.href).href
		}
	};
}
