/**
 * Absolute URLs the app talks to, resolved in the browser. Imports $app/paths,
 * so only pages may use it — never a module a node-environment test reaches.
 */
import { base } from '$app/paths';
import { relayEndpoint, solveEndpoint } from '$lib/relay/client';

export function appEndpoints() {
	const relayUrl = import.meta.env.VITE_RELAY_URL;
	return {
		/** pyodide/ and wheels/ live under it. */
		assetsBase: new URL(`${base}/`, location.href).href,
		relay: new URL(relayEndpoint(relayUrl), location.href).href,
		solve: new URL(solveEndpoint(relayUrl), location.href).href
	};
}
