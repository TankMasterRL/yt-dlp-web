/**
 * blob: URLs for jsdom, which has none: `installObjectUrls()` before rendering
 * (its `restore` afterwards). It says which URLs are live and what each is of:
 * a URL never revoked keeps its Blob's bytes for as long as the page is open.
 */
export function installObjectUrls() {
	const live = new Map<string, Blob>();
	let made = 0;
	const { createObjectURL, revokeObjectURL } = URL;
	Object.assign(URL, {
		createObjectURL(blob: Blob) {
			const url = `blob:test/${++made}`;
			live.set(url, blob);
			return url;
		},
		revokeObjectURL(url: string) {
			live.delete(url);
		}
	});
	return {
		live,
		/** The live URLs of `blob`. */
		of: (blob: Blob) => [...live].filter(([, b]) => b === blob).map(([url]) => url),
		restore: () => Object.assign(URL, { createObjectURL, revokeObjectURL })
	};
}
