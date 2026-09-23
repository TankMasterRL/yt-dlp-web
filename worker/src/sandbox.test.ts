// @vitest-environment node
/**
 * Runs the sandbox's module wrapper in a real JS engine (a child Node process,
 * never this one — capture.js replaces the global console) to prove programs
 * execute as ES modules and their printed output comes back.
 */
import { describe, expect, it } from 'vitest';
import { runInSandboxModules } from '../../tests/helpers/sandbox-runner';
import { sandboxCode } from './sandbox';

describe('sandbox module wrapper', () => {
	it('returns what the program prints', () => {
		expect(
			runInSandboxModules('console.log(JSON.stringify({ type: "result", responses: [] }));')
		).toBe('{"type":"result","responses":[]}');
	});

	it('runs scripts written the way yt-dlp-ejs writes them', () => {
		// lib assigns its exports onto globalThis; core then uses them as globals.
		const program = `var lib = { twice: (x) => x * 2 };
Object.assign(globalThis, lib);
function jsc(data) { return { type: 'result', responses: data.requests.map((r) => ({ type: 'result', data: twice(r.n) })) }; }
console.log(JSON.stringify(jsc({ requests: [{ n: 21 }] })));`;
		expect(JSON.parse(runInSandboxModules(program))).toEqual({
			type: 'result',
			responses: [{ type: 'result', data: 42 }]
		});
	});

	it('fails when the program throws', () => {
		expect(() => runInSandboxModules('throw new Error("player changed");')).toThrow(
			/player changed/
		);
	});

	it('describes a network-severed isolate with no bindings', () => {
		const code = sandboxCode('/* program */', 5000);
		expect(code.globalOutbound).toBeNull();
		expect(code.env).toEqual({});
		expect(code.limits).toEqual({ cpuMs: 5000, subRequests: 0 });
		expect(code.modules['program.js']).toBe('/* program */');
		expect(code.mainModule).toBe('main.js');
	});
});
