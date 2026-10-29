/**
 * An ISOBMFF (MP4/HEIF) box reader for tests, written from ISO/IEC 14496-12
 * and 23008-12 and independent of the app's AVIF muxer: it walks the boxes an
 * AVIF image sequence holds, checks every size, and reads the fields a player
 * relies on — down to the samples the sample tables point at.
 */

export interface Box {
	type: string;
	/** The payload, after the box header. */
	data: Uint8Array;
	/** Where the payload starts in the file. */
	offset: number;
	children: Box[];
}

/** Bytes before a box's children start: full box headers, sample entry fields. */
const CHILDREN_AFTER: Record<string, number> = {
	moov: 0,
	trak: 0,
	edts: 0,
	mdia: 0,
	minf: 0,
	dinf: 0,
	stbl: 0,
	iprp: 0,
	ipco: 0,
	meta: 4,
	stsd: 8,
	dref: 8,
	av01: 78
};

function readBoxes(file: Uint8Array, start: number, end: number): Box[] {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const boxes: Box[] = [];
	for (let at = start; at < end;) {
		const size = view.getUint32(at);
		if (size < 8 || at + size > end) throw new Error(`box at ${at} has size ${size}`);
		const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
		const skip = CHILDREN_AFTER[type];
		boxes.push({
			type,
			data: file.subarray(at + 8, at + size),
			offset: at + 8,
			children: skip === undefined ? [] : readBoxes(file, at + 8 + skip, at + size)
		});
		at += size;
	}
	if (
		boxes.length &&
		start === 0 &&
		boxes.at(-1)!.offset + boxes.at(-1)!.data.length !== file.length
	) {
		throw new Error('bytes after the last box');
	}
	return boxes;
}

export function child(box: Box | Box[], path: string): Box {
	let boxes = Array.isArray(box) ? box : box.children;
	let found: Box | undefined;
	for (const type of path.split('/')) {
		found = boxes.find((b) => b.type === type);
		if (!found) throw new Error(`no ${type} box (in ${path})`);
		boxes = found.children;
	}
	return found!;
}

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));

export interface Avif {
	brands: { major: string; compatible: string[] };
	primaryItem: number;
	item: { id: number; type: string; offset: number; length: number };
	properties: { type: string; data: Uint8Array; essential: boolean }[];
	movie: { timescale: number; duration: bigint };
	track: {
		width: number;
		height: number;
		duration: bigint;
		/** Edit list: repeat flag and segment duration. */
		repeat: boolean;
		segment: bigint;
		timescale: number;
		mediaDuration: bigint;
		handler: string;
		sampleEntry: { type: string; width: number; height: number; boxes: string[] };
		av1C: Uint8Array;
		colr: Uint8Array | null;
		/** stts, unrolled: each sample's duration. */
		durations: number[];
		/** 1-based sync sample numbers, or null when every sample is one. */
		sync: number[] | null;
		samples: Uint8Array[];
	};
}

export function readAvif(file: Uint8Array): Avif {
	const boxes = readBoxes(file, 0, file.length);
	if (boxes.map((b) => b.type).join() !== 'ftyp,meta,moov,mdat') {
		throw new Error(`top-level boxes ${boxes.map((b) => b.type).join()}`);
	}
	const view = (b: Box) => new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength);
	const ftyp = boxes[0].data;
	const brands = {
		major: fourcc(ftyp, 0),
		compatible: Array.from({ length: (ftyp.length - 8) / 4 }, (_, i) => fourcc(ftyp, 8 + i * 4))
	};

	const meta = boxes[1];
	if (fourcc(child(meta, 'hdlr').data, 8) !== 'pict') throw new Error('meta handler is not pict');
	const primaryItem = view(child(meta, 'pitm')).getUint16(4);
	const iloc = view(child(meta, 'iloc'));
	if (iloc.getUint8(4) !== 0x44 || iloc.getUint8(5) !== 0) throw new Error('unexpected iloc sizes');
	if (iloc.getUint16(6) !== 1 || iloc.getUint16(12) !== 1) throw new Error('one item, one extent');
	const iinf = child(meta, 'iinf');
	const infe = readBoxes(file, iinf.offset + 6, iinf.offset + iinf.data.length)[0];
	if (infe.type !== 'infe' || infe.data[0] !== 2) throw new Error('infe version 2 expected');
	const item = {
		id: iloc.getUint16(8),
		type: fourcc(infe.data, 8),
		offset: iloc.getUint32(14),
		length: iloc.getUint32(18)
	};
	if (view(infe).getUint16(4) !== item.id) throw new Error('infe and iloc name different items');
	const ipco = child(meta, 'iprp/ipco').children;
	const ipma = view(child(meta, 'iprp/ipma'));
	if (ipma.getUint32(4) !== 1 || ipma.getUint16(8) !== item.id)
		throw new Error('ipma: one entry for the item');
	const properties = Array.from({ length: ipma.getUint8(10) }, (_, i) => {
		const association = ipma.getUint8(11 + i);
		const property = ipco[(association & 0x7f) - 1];
		if (!property) throw new Error(`ipma names property ${association & 0x7f}`);
		return { type: property.type, data: property.data, essential: Boolean(association & 0x80) };
	});

	const moov = boxes[2];
	const mvhd = view(child(moov, 'mvhd'));
	if (mvhd.getUint8(0) !== 1) throw new Error('mvhd version 1 expected');
	const trak = child(moov, 'trak');
	const tkhd = view(child(trak, 'tkhd'));
	const elst = view(child(trak, 'edts/elst'));
	if (elst.getUint8(0) !== 1 || elst.getUint32(4) !== 1) throw new Error('one version 1 edit');
	const mdhd = view(child(trak, 'mdia/mdhd'));
	const stbl = child(trak, 'mdia/minf/stbl');
	const entry = child(stbl, 'stsd').children[0];
	const entryView = view(entry);
	const stts = view(child(stbl, 'stts'));
	const durations = Array.from({ length: stts.getUint32(4) }, (_, i) =>
		Array<number>(stts.getUint32(8 + i * 8)).fill(stts.getUint32(12 + i * 8))
	).flat();
	const stsz = view(child(stbl, 'stsz'));
	if (stsz.getUint32(4) !== 0) throw new Error('per-sample sizes expected');
	const sizes = Array.from({ length: stsz.getUint32(8) }, (_, i) => stsz.getUint32(12 + i * 4));
	const stsc = view(child(stbl, 'stsc'));
	if (stsc.getUint32(4) !== 1 || stsc.getUint32(12) !== sizes.length)
		throw new Error('one chunk of all samples');
	const stco = view(child(stbl, 'stco'));
	if (stco.getUint32(4) !== 1) throw new Error('one chunk offset');
	let at = stco.getUint32(8);
	const mdat = boxes[3];
	const samples = sizes.map((size) => {
		if (at < mdat.offset || at + size > mdat.offset + mdat.data.length)
			throw new Error('sample outside mdat');
		const sample = file.subarray(at, at + size);
		at += size;
		return sample;
	});
	const stss = stbl.children.find((b) => b.type === 'stss');
	const sync = stss
		? Array.from({ length: view(stss).getUint32(4) }, (_, i) => view(stss).getUint32(8 + i * 4))
		: null;
	if (durations.length !== samples.length) throw new Error('stts and stsz disagree');
	return {
		brands,
		primaryItem,
		item,
		properties,
		movie: { timescale: mvhd.getUint32(20), duration: mvhd.getBigUint64(24) },
		track: {
			width: tkhd.getUint32(88) / 65536,
			height: tkhd.getUint32(92) / 65536,
			duration: tkhd.getBigUint64(28),
			repeat: (elst.getUint32(0) & 0xffffff) === 1,
			segment: elst.getBigUint64(8),
			timescale: mdhd.getUint32(20),
			mediaDuration: mdhd.getBigUint64(24),
			handler: fourcc(child(trak, 'mdia/hdlr').data, 8),
			sampleEntry: {
				type: entry.type,
				width: entryView.getUint16(24),
				height: entryView.getUint16(26),
				boxes: entry.children.map((b) => b.type)
			},
			av1C: child(entry, 'av1C').data,
			colr: entry.children.find((b) => b.type === 'colr')?.data ?? null,
			durations,
			sync,
			samples
		}
	};
}
