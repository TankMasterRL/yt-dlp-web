/**
 * The transport seam between yt-dlp (Python, in Pyodide) and the network.
 *
 * `RelayRH` (src/python/ytdlp_web/relay_rh.py) turns every yt-dlp HTTP request
 * into one synchronous call of a {@link SyncTransport}. In the browser that is
 * `relaySync` (synchronous XHR to the relay Worker, see src/lib/relay/client.ts);
 * in tests it is a fixture table. The transport performs exactly ONE upstream
 * request: redirects come back as 3xx responses and yt-dlp follows them itself,
 * hop by hop, with its own cookie jar.
 */
export interface TransportRequest {
	method: string;
	/** Absolute upstream URL. */
	url: string;
	/** Upstream request headers, including ones XHR may not set (Cookie, Referer, Origin, User-Agent). */
	headers: [string, string][];
	body: Uint8Array | null;
	timeoutMs: number;
	/**
	 * Cap on the upstream body the transport should deliver. yt-dlp only needs
	 * pages, JSON and player scripts in memory; bulk media is fetched by the
	 * download worker, never through Python.
	 */
	maxBytes: number | null;
}

export interface TransportResponse {
	status: number;
	/** Upstream response headers; repeated names (Set-Cookie) appear once per value. */
	headers: [string, string][];
	body: Uint8Array;
	/** True when the upstream body was longer than `maxBytes` and was cut off. */
	truncated: boolean;
}

/** Must return synchronously — Python's request handlers are synchronous. Throw on network failure. */
export type SyncTransport = (request: TransportRequest) => TransportResponse;
