/**
 * Write the security headers from csp.config.js for hosts that can send them:
 *
 *   bun scripts/write-headers.ts              →  build/_headers
 *     Cloudflare Pages, Workers Static Assets and Netlify read it; GitHub Pages
 *     cannot send headers and ignores it. Runs after `vite build` (see the build
 *     script): the worker CSP's connect-src needs the VITE_RELAY_URL the app was
 *     built with, and BASE_PATH prefixes every path.
 *
 *   bun scripts/write-headers.ts --caddyfile  →  deploy/Caddyfile
 *     Committed, with Caddy environment placeholders instead of build-time
 *     values; a test fails when it drifts from csp.config.js.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basePathFromEnv, relayOriginFromEnv, securityHeaderRules } from '../csp.config.js';

type Rule = { path: string; headers: Record<string, string> };

export const CADDYFILE_PATH = 'deploy/Caddyfile';

export function headersFile(rules: readonly Rule[]): string {
	const blocks = rules.map((rule) =>
		[rule.path, ...Object.entries(rule.headers).map(([name, value]) => `  ${name}: ${value}`)].join(
			'\n'
		)
	);
	return `${blocks.join('\n\n')}\n`;
}

export interface CaddyDirective {
	/** No path: every request. */
	matcher: { path?: string; notPath?: string };
	headers: Record<string, string>;
}

/**
 * The rules as Caddy `header` directives that never set one field twice for a
 * path. Caddy orders `header` directives itself, so two directives setting the
 * same field could replace each other; mutually exclusive matchers make the
 * order irrelevant. Supports what securityHeaderRules produces: a catch-all
 * rule first, then more specific rules, each field refined by at most one of them.
 */
export function caddyHeaderPlan(rules: readonly Rule[]): CaddyDirective[] {
	const [catchAll, ...specific] = rules;
	if (
		!catchAll?.path.endsWith('/*') ||
		specific.some((r) => !r.path.startsWith(catchAll.path.slice(0, -1)))
	) {
		throw new Error('caddyHeaderPlan expects a catch-all rule first, then rules under it');
	}
	const plan: CaddyDirective[] = [];
	const add = (matcher: CaddyDirective['matcher'], name: string, value: string) => {
		const key = JSON.stringify(matcher);
		let directive = plan.find((d) => JSON.stringify(d.matcher) === key);
		if (!directive) plan.push((directive = { matcher, headers: {} }));
		directive.headers[name] = value;
	};
	const setters = (name: string) => specific.filter((rule) => name in rule.headers);
	for (const [name, value] of Object.entries(catchAll.headers)) {
		const refiners = setters(name);
		if (refiners.length > 1) throw new Error(`${name} is refined by more than one rule`);
		if (!refiners.length) add({}, name, value);
		else {
			// Merged as _headers merges: both values, comma-joined.
			add({ path: refiners[0].path }, name, `${value}, ${refiners[0].headers[name]}`);
			add({ notPath: refiners[0].path }, name, value);
		}
	}
	for (const rule of specific) {
		for (const [name, value] of Object.entries(rule.headers)) {
			if (name in catchAll.headers) continue;
			if (setters(name).length > 1) throw new Error(`${name} is set by more than one rule`);
			add({ path: rule.path }, name, value);
		}
	}
	return plan;
}

const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export function caddyfile(): string {
	// Placeholders Caddy fills from its environment when it loads the file.
	const plan = caddyHeaderPlan(securityHeaderRules({ relayOrigin: '{$RELAY_ORIGIN}' }));
	const lines: string[] = [];
	let named = 0;
	plan.forEach(({ matcher, headers }) => {
		const fields = Object.entries(headers).map(([name, value]) => `\t\t${name} ${quote(value)}`);
		if (matcher.path === undefined && matcher.notPath === undefined) {
			lines.push('\theader {', ...fields, '\t}');
			return;
		}
		const name = `@headers${++named}`;
		lines.push(
			matcher.path !== undefined
				? `\t${name} path ${matcher.path}`
				: `\t${name} not path ${matcher.notPath}`,
			`\theader ${name} {`,
			...fields,
			'\t}'
		);
	});
	return `# yt-dlp-web behind Caddy: the static build, plus the security headers that a
# <meta> CSP cannot carry (frame-ancestors, the workers' own CSP, …).
# GENERATED from csp.config.js by \`bun scripts/write-headers.ts --caddyfile\`:
# edit csp.config.js and regenerate — a test fails when this file drifts.
#
#   VITE_RELAY_URL=https://relay.example.workers.dev bun run build
#   SITE_ADDRESS=ytdlp.example.org RELAY_ORIGIN=https://relay.example.workers.dev \\
#     caddy run --config deploy/Caddyfile
#
# RELAY_ORIGIN is the origin of the VITE_RELAY_URL the app was built with (leave
# it unset when the relay shares this origin). Build without BASE_PATH: this
# serves the app from the site root.

{$SITE_ADDRESS:localhost} {
	root * {$SITE_ROOT:build}
	encode zstd gzip

${lines.join('\n')}

	file_server
	# Deep links SvelteKit did not prerender get the app's fallback page.
	handle_errors 404 {
		rewrite * /404.html
		file_server
	}
}
`;
}

if (import.meta.main) {
	const root = fileURLToPath(new URL('..', import.meta.url));
	if (process.argv.includes('--caddyfile')) {
		await writeFile(`${root}${CADDYFILE_PATH}`, caddyfile());
		console.log(`✓ wrote ${CADDYFILE_PATH}`);
	} else {
		const rules = securityHeaderRules({
			relayOrigin: relayOriginFromEnv(),
			base: basePathFromEnv()
		});
		await writeFile(`${root}build/_headers`, headersFile(rules));
		console.log(`✓ wrote build/_headers (${rules.length} rules)`);
	}
}
