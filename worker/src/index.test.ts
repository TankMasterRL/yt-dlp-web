// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { RelayHeader } from '../../src/lib/relay/protocol';
import worker from './index';
import type { Env } from './config';

const call = (path: string, env: Env, init?: RequestInit) =>
	worker.fetch(new Request(`https://relay.example${path}`, init) as never, env as never, {} as never);

describe('worker routing', () => {
	it('routes /relay to the relay', async () => {
		const res = await call('/relay', {});
		expect(res.status).toBe(400);
		expect(res.headers.get(RelayHeader.error)).toMatch(/X-Relay-Url/);
	});

	it('serves the static app when deployed all-in-one', async () => {
		const assets = { fetch: vi.fn(async () => new Response('<!doctype html>')) };
		const res = await call('/library/', { ASSETS: assets as never });
		expect(await res.text()).toBe('<!doctype html>');
		expect(assets.fetch).toHaveBeenCalledOnce();
	});

	it('404s everything else when relay-only', async () => {
		expect((await call('/', {})).status).toBe(404);
	});
});
