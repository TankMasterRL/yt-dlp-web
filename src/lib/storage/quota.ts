/**
 * How much more the browser lets this site store — where its storage estimate
 * says so at all. Some browsers report a `quota` that is no limit they hold
 * the site to, by design, so that the figure cannot tell sites, devices or
 * private windows apart. Each such report is matched here explicitly, for the
 * browser that makes it; every other quota is taken at its word.
 */

/** Which browser's quota rules an estimate comes under. */
export type QuotaReporter = 'brave' | 'chromium' | 'other';

/** The slice of `navigator` that tells the browser apart (TypeScript's DOM types have neither). */
export interface BrowserSignals {
	readonly brave?: unknown;
	readonly userAgentData?: { readonly brands?: readonly { readonly brand: string }[] };
}

const GiB = 2 ** 30;

/**
 * Brave sets every site's reported quota to this, on every platform, whatever
 * the site stores and whatever Brave lets it store; `usage` stays real
 * (brave-core#6622: a `setQuota` override).
 */
export const BRAVE_QUOTA = 2 ** 31;

/**
 * Brave says it is Brave with `navigator.brave` and with a "Brave" brand beside
 * "Chromium"; Chrome, Edge, Opera and the rest name "Chromium" among their
 * brands. Firefox and Safari have no `userAgentData`.
 */
export function quotaReporter(browser: BrowserSignals | Navigator): QuotaReporter {
	const signals = browser as BrowserSignals;
	const brands = signals.userAgentData?.brands?.map((b) => b.brand) ?? [];
	if (signals.brave !== undefined || brands.includes('Brave')) return 'brave';
	if (brands.includes('Chromium')) return 'chromium';
	return 'other';
}

/** Brave's fixed quota (brave-core#6622). */
function braveFixedQuota({ quota }: Required<StorageEstimate>): boolean {
	return quota === BRAVE_QUOTA;
}

/**
 * Chromium's static quota (`CalculateReportedQuota` in
 * storage/browser/quota/quota_manager_impl.cc, the StaticStorageQuota feature,
 * on by default since M133): usage + 10 GiB, or usage + the disk's size rounded
 * up to a whole GiB where the disk is under 10 GiB. Chromium 153 reports
 * incognito's memory pool so too (usage + 3 GiB here, where writes failed past
 * 1 GiB); its main branch reports + 10 GiB there.
 */
function chromiumStaticQuota({ usage, quota }: Required<StorageEstimate>): boolean {
	const extra = quota - usage;
	return extra % GiB === 0 && extra >= GiB && extra <= 10 * GiB;
}

/** Each browser's quotas that are no limit, Brave's own first (it is a Chromium too). */
const NO_LIMIT: Record<QuotaReporter, readonly ((e: Required<StorageEstimate>) => boolean)[]> = {
	brave: [braveFixedQuota, chromiumStaticQuota],
	chromium: [chromiumStaticQuota],
	other: []
};

/**
 * The room the estimate leaves, or null where it names none: no quota, a
 * browser's quota that is no limit (above), or a quota the site has already
 * gone past, which cannot be one it is held to.
 */
export function storageRoom(
	{ usage = 0, quota = 0 }: StorageEstimate,
	reporter: QuotaReporter
): number | null {
	if (!quota || usage > quota) return null;
	if (NO_LIMIT[reporter].some((noLimit) => noLimit({ usage, quota }))) return null;
	return quota - usage;
}
