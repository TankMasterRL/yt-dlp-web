// Everything runs client-side (Pyodide in a Web Worker, OPFS, IndexedDB), so
// each route prerenders to a static shell that hydrates in the browser.
export const prerender = true;
export const ssr = false;
export const trailingSlash = 'always';
