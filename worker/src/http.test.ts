// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RelayHeader } from '../../src/lib/relay/protocol';
import { headerSafe, plainError } from './http';

describe('error responses', () => {
	// workerd reports isolate failures as multi-line messages with a stack; CR/LF
	// in a header value makes `new Response()` throw, turning a 422 into a 500.
	const multiLine = 'Error: player changed\n    at program.js:1:7\r\n    at main.js:2:1';

	it('never put CR, LF or control characters in a header value', () => {
		expect(headerSafe(multiLine)).toBe('Error: player changed at program.js:1:7 at main.js:2:1');
		expect(headerSafe('tab\there\u0000nul')).toBe('tab here nul');
	});

	it('replace characters a header cannot carry', () => {
		expect(headerSafe('naïve → ✓')).toBe('naïve ? ?');
	});

	it('cap header length', () => {
		expect(headerSafe('x'.repeat(5000)).length).toBeLessThanOrEqual(512);
	});

	it('build a response for any reason, keeping the full text in the body', async () => {
		const res = plainError(422, multiLine);
		expect(res.status).toBe(422);
		expect(res.headers.get(RelayHeader.error)).toBe(headerSafe(multiLine));
		expect(await res.text()).toBe(multiLine);
	});
});
