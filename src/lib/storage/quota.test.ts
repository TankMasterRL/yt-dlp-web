// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BRAVE_QUOTA, quotaReporter, storageRoom } from './quota';

const GiB = 2 ** 30;
const brands = (...names: string[]) => ({
	userAgentData: { brands: names.map((brand) => ({ brand, version: '1' })) }
});

describe('quotaReporter', () => {
	it('knows Brave by navigator.brave or by its brand', () => {
		expect(quotaReporter({ brave: {} })).toBe('brave');
		expect(quotaReporter(brands('Brave', 'Chromium', 'Not_A Brand'))).toBe('brave');
	});

	it('knows any other Chromium by its brand', () => {
		expect(quotaReporter(brands('Chromium', 'Google Chrome', 'Not_A Brand'))).toBe('chromium');
		expect(quotaReporter(brands('Not_A Brand', 'Chromium', 'Microsoft Edge'))).toBe('chromium');
	});

	it('calls the rest other: Firefox and Safari have no userAgentData', () => {
		expect(quotaReporter({})).toBe('other');
		expect(quotaReporter(brands())).toBe('other');
	});
});

describe('storageRoom', () => {
	// Brave tells every site the same 2 GiB, whatever it stores and whatever it
	// may store: past 2 GiB the page said "room for 0 B more" (brave-core#6622).
	it("names no room from Brave's fixed quota, above it or below it", () => {
		expect(BRAVE_QUOTA).toBe(2147483648);
		for (const usage of [0, GiB / 2, 3 * GiB])
			expect(storageRoom({ usage, quota: BRAVE_QUOTA }, 'brave')).toBeNull();
	});

	// CalculateReportedQuota: usage + 10 GiB, or + the disk rounded up to a whole
	// GiB where it is under 10 GiB (and, in Chromium 153, incognito's pool: + 3 GiB).
	it("names no room from Chromium's usage + whole GiB, in Brave too", () => {
		for (const extra of [1, 3, 10])
			for (const usage of [0, 1.37 * GiB, 25 * GiB + 123]) {
				expect(storageRoom({ usage, quota: usage + extra * GiB }, 'chromium')).toBeNull();
				expect(storageRoom({ usage, quota: usage + extra * GiB }, 'brave')).toBeNull();
			}
	});

	it('names the room from a Chromium quota that is no static one (unlimited storage, policy)', () => {
		expect(storageRoom({ usage: GiB, quota: 300e9 }, 'chromium')).toBe(300e9 - GiB);
		expect(storageRoom({ usage: 0, quota: 11 * GiB }, 'chromium')).toBe(11 * GiB);
		// Brave's 2 GiB, from a Chromium that does not say it is Brave, is just a quota.
		expect(storageRoom({ usage: GiB / 2, quota: BRAVE_QUOTA }, 'chromium')).toBe(1.5 * GiB);
	});

	it('takes other browsers at their word, even where a figure looks like one of those', () => {
		// Firefox's best-effort limit is at most 10 GiB: an empty site has exactly that.
		expect(storageRoom({ usage: 0, quota: 10 * GiB }, 'other')).toBe(10 * GiB);
		expect(storageRoom({ usage: 3 * GiB + 5, quota: 10 * GiB }, 'other')).toBe(7 * GiB - 5);
		expect(storageRoom({ usage: GiB, quota: BRAVE_QUOTA }, 'other')).toBe(GiB);
		// Used up to the byte: the quota may well be real, and full.
		expect(storageRoom({ usage: 10 * GiB, quota: 10 * GiB }, 'other')).toBe(0);
	});

	it('names no room where there is no quota, or one the site has already gone past', () => {
		expect(storageRoom({}, 'other')).toBeNull();
		expect(storageRoom({ usage: GiB, quota: 0 }, 'other')).toBeNull();
		expect(storageRoom({ usage: 5 * GiB + 1, quota: 5 * GiB }, 'other')).toBeNull();
	});
});
