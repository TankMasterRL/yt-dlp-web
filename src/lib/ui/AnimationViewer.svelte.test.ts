import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenedImage } from '#lib/animate/opened.ts';
import { viewOpened } from '#lib/animate/opened.ts';
import type { ImageInfo } from '#lib/animate/read.ts';
import { installDialog } from '../../../tests/helpers/dialog';
import { installObjectUrls } from '../../../tests/helpers/object-urls';
import AnimationViewer from './AnimationViewer.svelte';

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

function opened(id: string, name: string, info: Partial<ImageInfo>): OpenedImage {
	return {
		id,
		file: new File([new Uint8Array(2048)], name),
		info: {
			format: 'gif',
			animated: true,
			width: 480,
			height: 270,
			frames: 24,
			duration: 2,
			...info
		}
	};
}

/** Files opened from the device: a GIF, a still PNG and a JPEG XL. */
function setup() {
	const files = [
		opened('a', 'party.gif', {}),
		opened('b', 'logo.png', { format: 'apng', animated: false, frames: 1, duration: null }),
		opened('c', 'walk.jxl', { format: 'jxl', width: 64, height: 36, frames: null, duration: null })
	];
	const save = vi.fn(async (_file: Blob, _name: string) => {});
	const onclose = vi.fn();
	const view = render(AnimationViewer, {
		items: files.map(viewOpened),
		id: 'a',
		save,
		onclose
	});
	return { files, save, onclose, ...view };
}

describe('AnimationViewer, of files opened from the device', () => {
	it('names each by its file and says what its headers say', () => {
		const { files } = setup();
		const dialog = screen.getByRole('dialog');
		expect(dialog).toHaveAttribute('open');
		expect(dialog).toHaveAccessibleName('party.gif');
		expect(dialog).toHaveAccessibleDescription('GIF from this device');
		expect(dialog).toHaveTextContent('480 × 270 px · 24 frames · 2.0 s · 2.0 KiB');
		const image = within(dialog).getByRole('img', {
			name: 'The animated GIF party.gif'
		}) as HTMLImageElement;
		// The picked file itself, by a URL of its own.
		expect(image.src).toBe(urls.of(files[0].file)[0]);
		expect(image).toHaveAttribute('width', '480');
	});

	it("steps through them, and offers neither to save nor to remove the person's own files", async () => {
		setup();
		const dialog = screen.getByRole('dialog');
		expect(dialog).toHaveTextContent('1 of 3');
		expect(within(dialog).queryByRole('button', { name: /^Save/ })).toBeNull();
		expect(within(dialog).queryByRole('button', { name: 'Remove' })).toBeNull();
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Next animation' }));
		expect(dialog).toHaveAccessibleName('logo.png');
		expect(dialog).toHaveTextContent('PNG from this device');
		expect(dialog).toHaveTextContent('480 × 270 px · 1 frame · 2.0 KiB');
		expect(within(dialog).getByRole('img')).toHaveAccessibleName('The PNG logo.png');
		await fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		expect(dialog).toHaveAccessibleName('walk.jxl');
		expect(dialog).toHaveTextContent('64 × 36 px · animated · 2.0 KiB');
		await fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		expect(dialog).toHaveTextContent('1 of 3');
	});

	it("says so when the browser can't show one, without vouching for the file", async () => {
		setup();
		const dialog = screen.getByRole('dialog');
		await fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
		await fireEvent.error(within(dialog).getByRole('img'));
		expect(dialog.querySelector('[data-unshowable]')).toHaveTextContent(
			"This browser can't show this JPEG XL image. Open it with a browser or viewer that can."
		);
	});

	it('closes when asked, and holds no URL once it is gone', async () => {
		const { onclose, unmount, container } = setup();
		await fireEvent.click(screen.getByRole('button', { name: 'Close the animation viewer' }));
		expect(onclose).toHaveBeenCalledOnce();
		expect(container.querySelector('dialog')).not.toHaveAttribute('open');
		unmount();
		expect(urls.live.size).toBe(0);
	});

	it('shows one file alone, with nothing to step to', () => {
		render(AnimationViewer, {
			items: [viewOpened(opened('a', 'party.gif', {}))],
			id: 'a',
			onclose: () => {}
		});
		expect(screen.queryByRole('button', { name: 'Next animation' })).toBeNull();
		expect(screen.getByRole('dialog')).not.toHaveTextContent('1 of 1');
	});
});
