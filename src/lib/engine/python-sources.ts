/**
 * Our Python package, bundled as strings and written into Pyodide's virtual
 * file system at boot — no extra requests, nothing to allow in CSP.
 */
import init from '../../python/ytdlp_web/__init__.py?raw';
import api from '../../python/ytdlp_web/api.py?raw';
import bootstrap from '../../python/ytdlp_web/bootstrap.py?raw';
import relayRh from '../../python/ytdlp_web/relay_rh.py?raw';
import solverJcp from '../../python/ytdlp_web/solver_jcp.py?raw';
import transport from '../../python/ytdlp_web/transport.py?raw';

/** Paths are relative to site-packages. */
export const PYTHON_SOURCES: Readonly<Record<string, string>> = {
	'ytdlp_web/__init__.py': init,
	'ytdlp_web/transport.py': transport,
	'ytdlp_web/relay_rh.py': relayRh,
	'ytdlp_web/solver_jcp.py': solverJcp,
	'ytdlp_web/bootstrap.py': bootstrap,
	'ytdlp_web/api.py': api
};
