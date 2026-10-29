"""Browser integration for yt-dlp running in Pyodide.

yt-dlp itself is never patched. Everything here plugs into its public plugin
seams: a RequestHandler for networking (``relay_rh``) and, for YouTube's
JavaScript challenges, a JsChallengeProvider (``solver_jcp``). ``bootstrap``
wires them in; ``api`` is the small surface the engine worker calls.
"""
