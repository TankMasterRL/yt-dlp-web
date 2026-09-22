import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { FormatInfo } from '$lib/engine/runtime';
import FormatTable from './FormatTable.svelte';

const formats: FormatInfo[] = [
	{ format_id: '140', url: 'https://x/140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 3_500_000 },
	{ format_id: '18', url: 'https://x/18', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 360, filesize_approx: 9_000_000 },
	{ format_id: '137', url: 'https://x/137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080 },
	{ format_id: '96', url: 'https://x/96.m3u8', ext: 'mp4', protocol: 'm3u8_native', vcodec: 'avc1', acodec: 'mp4a', height: 1080 }
];

describe('FormatTable', () => {
	it('lists formats best first, describing each', () => {
		render(FormatTable, { formats });
		const rows = screen.getAllByRole('row').slice(1);
		expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent?.trim())).toEqual([
			'96',
			'137',
			'18',
			'140'
		]);
		const [, hd, sd, audio] = rows;
		expect(within(hd).getByText('Video only')).toBeInTheDocument();
		expect(within(hd).getByText('1080p')).toBeInTheDocument();
		expect(within(sd).getByText('Video + audio')).toBeInTheDocument();
		expect(within(sd).getByText('≈ 8.6 MiB')).toBeInTheDocument();
		expect(within(audio).getByText('Audio only')).toBeInTheDocument();
		expect(within(audio).getByText('3.3 MiB')).toBeInTheDocument();
	});

	it('marks the format yt-dlp recommends', () => {
		render(FormatTable, { formats, recommended: '18' });
		const row = screen.getByText('recommended').closest('tr')!;
		expect(within(row).getAllByRole('cell')[0]).toHaveTextContent('18');
	});

	it('offers downloads for plain formats only', async () => {
		const onDownload = vi.fn();
		render(FormatTable, { formats, onDownload });
		expect(screen.queryByRole('button', { name: 'Download format 96' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Download format 18' }));
		expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ format_id: '18' }));
	});

	it('has no action column when downloading is not available', () => {
		render(FormatTable, { formats });
		expect(screen.queryAllByRole('button')).toHaveLength(0);
	});
});
