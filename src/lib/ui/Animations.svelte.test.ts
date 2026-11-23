import { flushSync } from 'svelte';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Animation } from '#lib/animate/editor.svelte.ts';
import { AnimationGallery } from '#lib/animate/gallery.svelte.ts';
import { installDialog } from '../../../tests/helpers/dialog';
import { installObjectUrls } from '../../../tests/helpers/object-urls';
import Animations from './Animations.svelte';

function animation(overrides: Partial<Animation> = {}): Animation {
	return {
		format: 'gif',
		blob: new Blob([new Uint8Array(1000)], { type: 'image/gif' }),
		width: 480,
		height: 270,
		frames: 24,
		duration: 2,
		range: { start: 0, end: 2 },
		...overrides
	};
}

let urls: ReturnType<typeof installObjectUrls>;
let restoreDialog: () => void;
beforeEach(() => {
	urls = installObjectUrls();
	restoreDialog = installDialog();
});
afterEach(() => {
	urls.restore();
	restoreDialog();
});

/** A gallery of a GIF, then an APNG, then a JPEG XL (newest first: JPEG XL, APNG, GIF). */
function setup(count = 3) {
	const gallery = new AnimationGallery();
	const made = [
		gallery.add(animation(), { title: 'Big Buck Fixture', formatId: '0' }),
		gallery.add(
			animation({
				format: 'apng',
				blob: new Blob([new Uint8Array(3000)], { type: 'image/png' }),
				width: 240,
				height: 135,
				range: { start: 0.5, end: 1.5 },
				frames: 10,
				duration: 1
			}),
			{ title: 'bbf-360' }
		),
		gallery.add(animation({ format: 'jxl', blob: new Blob(['jxl'], { type: 'image/jxl' }) }), {
			title: 'bbf-360'
		})
	].slice(0, count);
	for (const extra of gallery.items.filter((a) => !made.includes(a))) gallery.remove(extra.id);
	const save = vi.fn(async (_file: Blob, _name: string) => {});
	const view = render(Animations, { gallery, save });
	return { gallery, made, save, ...view };
}

const cards = () =>
	within(screen.getByRole('list', { name: 'Animations made in this tab' })).getAllByRole('figure');
const viewer = () => screen.getByRole('dialog');

describe('Animations', () => {
	it('shows nothing until an animation is made, and then each as soon as it is', () => {
		const gallery = new AnimationGallery();
		render(Animations, { gallery });
		expect(screen.queryByRole('region', { name: 'Animations' })).toBeNull();

		gallery.add(animation(), { title: 'Big Buck Fixture' });
		flushSync();
		expect(screen.getByRole('region', { name: 'Animations' })).toBeInTheDocument();
		expect(cards()).toHaveLength(1);
	});

	it('shows every animation made, newest first, each playing from a URL of its own', () => {
		const { made } = setup();
		const [gif, apng] = made;
		expect(cards().map((card) => card.getAttribute('aria-label'))).toEqual([
			'JPEG XL of bbf-360, 0:00.0 to 0:02.0',
			'APNG of bbf-360, 0:00.5 to 0:01.5',
			'GIF of Big Buck Fixture, 0:00.0 to 0:02.0'
		]);
		const card = cards()[1];
		expect(card).toHaveTextContent('bbf-360');
		expect(card).toHaveTextContent('APNG · 0:00.5–0:01.5');
		expect(card).toHaveTextContent('240 × 135 px · 2.9 KiB');
		const image = card.querySelector('img')!;
		expect(image.src).toBe(urls.of(apng.blob)[0]);
		expect(image).toHaveAttribute('width', '240');
		expect(image).toHaveAttribute('height', '135');
		// One URL each, the image is the file itself.
		expect(urls.of(gif.blob)).toHaveLength(1);
		expect(urls.live.size).toBe(3);
	});

	it('says how many there are, what they hold, and that they last only while the tab is open', () => {
		setup();
		const region = screen.getByRole('region', { name: 'Animations' });
		expect(region).toHaveTextContent('3 animations · 3.9 KiB');
		expect(region).toHaveTextContent(/until this tab is reloaded or closed/);
	});

	it("says so when the browser can't show one", async () => {
		setup();
		const jxl = cards()[0];
		await fireEvent.error(jxl.querySelector('img')!);
		expect(jxl.querySelector('img')).toBeNull();
		expect(jxl.querySelector('[data-unshowable]')).toHaveTextContent("Can't show JPEG XL here");
		// The others are shown as they were.
		expect(cards()[1].querySelector('img')).not.toBeNull();
	});

	it('saves one under the name the animation maker gives it', async () => {
		const { save, made } = setup();
		await fireEvent.click(
			screen.getByRole('button', { name: 'Save APNG of bbf-360, 0:00.5 to 0:01.5' })
		);
		expect(save).toHaveBeenCalledWith(made[1].blob, 'bbf-360 (0.5s-1.5s).png');
	});

	it('lets one go: its URL is revoked so its bytes can be freed, and focus stays in the list', async () => {
		const { gallery, made } = setup();
		const [gif, apng, jxl] = made;
		await fireEvent.click(
			screen.getByRole('button', { name: 'Remove APNG of bbf-360, 0:00.5 to 0:01.5' })
		);
		expect(gallery.items).toEqual([jxl, gif]);
		expect(cards()).toHaveLength(2);
		expect(urls.of(apng.blob)).toEqual([]);
		expect(urls.live.size).toBe(2);
		// On the one now in its place.
		expect(document.activeElement).toHaveAccessibleName(
			'View GIF of Big Buck Fixture, 0:00.0 to 0:02.0'
		);
	});

	it('lets every URL go with the page', () => {
		const { unmount } = setup();
		unmount();
		expect(urls.live.size).toBe(0);
	});

	describe('viewer', () => {
		it('opens one large, in a dialog of its own', async () => {
			const { made } = setup();
			await fireEvent.click(
				screen.getByRole('button', { name: 'View APNG of bbf-360, 0:00.5 to 0:01.5' })
			);
			const dialog = viewer();
			expect(dialog).toHaveAttribute('open');
			expect(dialog).toHaveAccessibleName('bbf-360');
			expect(dialog).toHaveTextContent('APNG of 0:00.5 to 0:01.5 of the video');
			expect(dialog).toHaveTextContent('240 × 135 px · 10 frames · 1.0 s · 2.9 KiB');
			expect(dialog).toHaveTextContent('2 of 3');
			const image = within(dialog).getByRole('img', {
				name: 'The animated APNG: 0:00.5 to 0:01.5 of bbf-360'
			}) as HTMLImageElement;
			expect(image.src).toBe(urls.of(made[1].blob).at(-1));
		});

		it('steps through them by its buttons and the arrow keys, round from the last to the first', async () => {
			setup();
			await fireEvent.click(
				screen.getByRole('button', { name: 'View GIF of Big Buck Fixture, 0:00.0 to 0:02.0' })
			);
			const dialog = viewer();
			expect(dialog).toHaveTextContent('3 of 3');
			await fireEvent.click(within(dialog).getByRole('button', { name: 'Next animation' }));
			expect(dialog).toHaveTextContent('1 of 3');
			expect(dialog).toHaveTextContent('JPEG XL of 0:00.0 to 0:02.0');
			await fireEvent.keyDown(dialog, { key: 'ArrowRight' });
			expect(dialog).toHaveTextContent('2 of 3');
			expect(dialog).toHaveAccessibleName('bbf-360');
			await fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
			await fireEvent.click(within(dialog).getByRole('button', { name: 'Previous animation' }));
			expect(dialog).toHaveTextContent('3 of 3');
			expect(dialog).toHaveAccessibleName('Big Buck Fixture');
			// Arrows with a modifier are the browser's.
			await fireEvent.keyDown(dialog, { key: 'ArrowLeft', altKey: true });
			expect(dialog).toHaveTextContent('3 of 3');
		});

		it("says so when the browser can't show one, and shows the next as it is", async () => {
			setup();
			await fireEvent.click(
				screen.getByRole('button', { name: 'View JPEG XL of bbf-360, 0:00.0 to 0:02.0' })
			);
			const dialog = viewer();
			await fireEvent.error(within(dialog).getByRole('img'));
			expect(dialog.querySelector('[data-unshowable]')).toHaveTextContent(
				"This browser can't show JPEG XL images"
			);
			await fireEvent.click(within(dialog).getByRole('button', { name: 'Next animation' }));
			expect(dialog.querySelector('[data-unshowable]')).toBeNull();
			expect(within(dialog).getByRole('img')).toHaveAccessibleName(
				'The animated APNG: 0:00.5 to 0:01.5 of bbf-360'
			);
		});

		it('saves the one on show', async () => {
			const { save, made } = setup();
			await fireEvent.click(
				screen.getByRole('button', { name: 'View GIF of Big Buck Fixture, 0:00.0 to 0:02.0' })
			);
			await fireEvent.click(within(viewer()).getByRole('button', { name: 'Save GIF' }));
			expect(save).toHaveBeenCalledWith(made[0].blob, 'Big Buck Fixture (0.0s-2.0s) [0].gif');
		});

		it('removes the one on show and shows the next; removing the last closes it', async () => {
			const { gallery, made } = setup(2);
			const [gif, apng] = made;
			await fireEvent.click(
				screen.getByRole('button', { name: 'View APNG of bbf-360, 0:00.5 to 0:01.5' })
			);
			const dialog = viewer();
			await fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
			expect(gallery.items).toEqual([gif]);
			expect(urls.of(apng.blob)).toEqual([]);
			expect(dialog).toHaveAccessibleName('Big Buck Fixture');
			// Alone, there is nothing to step to.
			expect(within(dialog).queryByRole('button', { name: 'Next animation' })).toBeNull();

			await fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
			expect(gallery.items).toEqual([]);
			expect(screen.queryByRole('dialog')).toBeNull();
			expect(screen.queryByRole('region', { name: 'Animations' })).toBeNull();
			expect(urls.live.size).toBe(0);
		});

		it('closes, letting go of its own URL', async () => {
			const { made } = setup();
			await fireEvent.click(
				screen.getByRole('button', { name: 'View GIF of Big Buck Fixture, 0:00.0 to 0:02.0' })
			);
			expect(urls.of(made[0].blob)).toHaveLength(2);
			await fireEvent.click(
				within(viewer()).getByRole('button', { name: 'Close the animation viewer' })
			);
			expect(screen.queryByRole('dialog')).toBeNull();
			expect(urls.of(made[0].blob)).toHaveLength(1);
		});
	});
});
