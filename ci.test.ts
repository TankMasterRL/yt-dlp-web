// @vitest-environment node
/**
 * CI keeps the results of every failed e2e attempt, first attempts that passed
 * on retry included: a test that only passes on retry is still a failure to
 * explain, and its trace is the explanation.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Bun', () => {
	it("is one version, named once: package.json's packageManager", () => {
		const version = JSON.parse(source('package.json')).packageManager?.match(
			/^bun@(\d+\.\d+\.\d+)$/
		)?.[1];
		expect(version, 'package.json packageManager: "bun@x.y.z"').toBeDefined();

		// Every Dockerfile.test stage copies its bun binary from that release's image…
		const images = [...source('Dockerfile.test').matchAll(/--from=oven\/bun:(\S+)/g)].map(
			(match) => match[1]
		);
		expect(images.length).toBeGreaterThan(0);
		for (const image of images) expect(image).toBe(version);

		// …and every workflow that sets Bun up reads the version from package.json.
		const workflows = readdirSync(new URL('.github/workflows/', import.meta.url))
			.map((name) => source(`.github/workflows/${name}`))
			.filter((workflow) => workflow.includes('oven-sh/setup-bun@'));
		expect(workflows.length).toBeGreaterThan(0);
		for (const workflow of workflows) {
			expect(workflow).toContain('bun-version-file: package.json');
			expect(workflow).not.toMatch(/bun-version:/);
		}
	});
});

describe('CI keeps the e2e results of every failed attempt', () => {
	it('gives each Playwright run in the gate its own directory under test-results/', () => {
		// Playwright empties its output directory when it starts, so a second run
		// into the same one deletes the first run's traces.
		const command = source('Dockerfile.test').match(/^CMD (.+)$/m)?.[1] ?? '';
		const runs = command.split('&&').filter((step) => step.includes('test:e2e'));
		const outputs = runs.map((run) => run.match(/--output[ =](\S+?)["\s]/)?.[1] ?? 'test-results');
		expect(runs.length).toBeGreaterThan(1);
		expect(new Set(outputs).size).toBe(runs.length);
		for (const output of outputs) expect(output).toMatch(/^test-results(\/|$)/);
	});

	it('uploads test-results/ unless the run was cancelled, not only when the job failed', () => {
		const upload = source('.github/workflows/ci.yml')
			.split(/\n(?= {6}- )/)
			.find((step) => step.includes('actions/upload-artifact@'));
		expect(upload).toContain('if: ${{ !cancelled() }}');
		expect(upload).toContain('path: test-results/');
		// A run without a failed attempt leaves nothing to upload.
		expect(upload).toContain('if-no-files-found: ignore');
	});
});

describe("CI's browsers", () => {
	it('come from the Playwright image of the exact @playwright/test version bun.lock resolves', () => {
		// The image ships the browser builds that one Playwright release drives;
		// any other pairing is untested, so the two move together.
		const locked = source('bun.lock').match(
			/"@playwright\/test": \["@playwright\/test@([^"]+)"/
		)?.[1];
		const pinned = JSON.parse(source('package.json')).devDependencies['@playwright/test'];
		const image = source('Dockerfile.test').match(
			/^FROM mcr\.microsoft\.com\/playwright:v(\S+)-noble$/m
		)?.[1];
		expect(locked).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pinned).toBe(locked);
		expect(image).toBe(locked);
	});
});
