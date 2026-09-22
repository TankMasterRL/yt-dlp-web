import { describe, expect, it } from 'vitest';
import { exportFileName, progressLabel, statusLabel } from './present';

describe('exportFileName', () => {
	it('builds "<title> [<format>].<ext>"', () => {
		expect(exportFileName({ title: 'Big Buck Bunny', formatId: '18', ext: 'mp4' })).toBe(
			'Big Buck Bunny [18].mp4'
		);
	});

	it('replaces characters no file system accepts, and trailing dots/spaces', () => {
		expect(exportFileName({ title: 'a/b\\c:d*e?f"g<h>i|j\u0007. ', formatId: 'x', ext: 'webm' })).toBe(
			'a_b_c_d_e_f_g_h_i_j_ [x].webm'
		);
	});

	it('never lets a title escape into a path or hide as a dotfile', () => {
		// Separators become "_" and a leading run of dots collapses to one "_".
		expect(exportFileName({ title: '../../etc/passwd', formatId: '1', ext: 'mp4' })).toBe(
			'__.._etc_passwd [1].mp4'
		);
		expect(exportFileName({ title: '.bashrc', formatId: '1', ext: 'mp4' })).toBe('_bashrc [1].mp4');
		expect(exportFileName({ title: '', formatId: '1', ext: 'mp4' })).toBe('video [1].mp4');
	});

	it('keeps names to a sane length', () => {
		expect(exportFileName({ title: 'x'.repeat(500), formatId: '1', ext: 'mp4' }).length).toBeLessThanOrEqual(180);
	});
});

describe('progress', () => {
	it('shows percent when the size is known', () => {
		expect(progressLabel({ bytesDone: 512 * 1024, bytesTotal: 2 * 1024 * 1024 })).toBe('25% · 512.0 KiB of 2.0 MiB');
	});
	it('shows bytes when it is not', () => {
		expect(progressLabel({ bytesDone: 1536, bytesTotal: null })).toBe('1.5 KiB');
	});
	it('describes statuses in words', () => {
		expect(statusLabel('complete')).toBe('Downloaded');
		expect(statusLabel('paused')).toBe('Paused');
	});
});
