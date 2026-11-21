<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		MIN_SPAN,
		formatClipTime,
		frameMarks,
		moveRange,
		revealTime,
		setRangeEdge,
		type TimeRange
	} from '#lib/animate/clip.ts';
	import type { PictureGrid } from '#lib/animate/grid.ts';
	import { followPointer } from './drag';
	import { observeSize } from './size';
	import { edgeTarget, moveDelta } from './slider-keys';

	type Edge = 'start' | 'end';

	interface Props {
		range: TimeRange;
		/** Seconds. */
		duration: number;
		/**
		 * The stretch of the video the track shows, when zoomed in (null: all of it).
		 * The keyboard moves it along to show what it moves out of it.
		 */
		view?: TimeRange | null;
		/** Where the preview is, marked on the track. */
		playhead?: number | null;
		disabled?: boolean;
		/** Someone moved an edge: `time` is where it is now (to show the frame there). */
		onscrub?: (edge: Edge, time: number) => void;
		/** The animation's frame rate: where they stand apart, its frames are marked on the range. */
		fps?: number | null;
		/**
		 * Where the video's pictures start, once its frame rate is known: the arrow keys
		 * then step the range a picture at a time (without, a tenth of a second).
		 */
		pictures?: PictureGrid | null;
		/** Pictures across the whole track (the frame timeline), darkened outside the range. */
		children?: Snippet;
	}

	let {
		range = $bindable(),
		duration,
		view = $bindable(null),
		playhead = null,
		disabled = false,
		onscrub,
		fps = null,
		pictures = null,
		children
	}: Props = $props();

	const EDGES: Edge[] = ['start', 'end'];
	const LABEL: Record<Edge, string> = { start: 'Start', end: 'End' };

	let track: HTMLDivElement;
	/** CSS pixels; 0 until laid out. */
	let trackWidth = $state(0);
	/** What the track shows: the stretch zoomed in on, or the whole video. */
	const shown = $derived(view ?? { start: 0, end: duration });
	const shownLength = $derived(shown.end - shown.start);
	const span = $derived(Math.min(MIN_SPAN, duration));
	const marks = $derived(fps ? frameMarks(range, fps, shownLength, trackWidth) : null);
	/** As late as the range can start, its length kept. */
	const latest = $derived(moveRange(range, duration, duration).start);
	/** How far across the track a time is (past its ends for times it does not show). */
	const percent = (time: number) =>
		shownLength > 0 ? ((time - shown.start) / shownLength) * 100 : 0;
	/** The same, kept on the track. */
	const onTrack = (time: number) => Math.min(Math.max(percent(time), 0), 100);
	const showing = (time: number) => time >= shown.start && time <= shown.end;
	/** What shows of the range, across the track. */
	const left = $derived(onTrack(range.start));
	const right = $derived(onTrack(range.end));
	/** Both ends on the track: their thumbs make room for each other. */
	const paired = $derived(showing(range.start) && showing(range.end));
	/** Where the frame marks run, across the track. */
	const marked = $derived(
		marks ? { left: percent(marks.start), width: (marks.length / shownLength) * 100 } : null
	);

	function timeAt(clientX: number): number {
		const rect = track.getBoundingClientRect();
		return rect.width ? shown.start + ((clientX - rect.left) / rect.width) * shownLength : 0;
	}

	/** Moves what the track shows as little as it takes to show each time, the last for sure. */
	function reveal(...times: number[]) {
		let next = shown;
		for (const time of times) next = revealTime(next, time, duration);
		if (next !== shown) view = next;
	}

	/**
	 * Whether focus is being given by a pointer press, which shows what it pressed:
	 * what the track shows stays put under the pointer.
	 */
	let pressing = false;

	function focusPressed(element: HTMLElement) {
		pressing = true;
		element.focus();
		pressing = false;
	}

	/** Focus from the keyboard brings what it lands on into view. */
	function focused(...times: number[]) {
		if (!pressing) reveal(...times);
	}

	/**
	 * What an end's thumb covers of the video, its end's own time last: the thumb stands
	 * inside the range, from where it starts or up to where it ends, so showing the time
	 * alone could leave the thumb running past the track, on the far side of it.
	 */
	function thumbTimes(edge: Edge, thumb: HTMLElement): number[] {
		const width = track.getBoundingClientRect().width;
		const covers = width ? (thumb.getBoundingClientRect().width / width) * shownLength : 0;
		return edge === 'start' ? [range.start + covers, range.start] : [range.end - covers, range.end];
	}

	function setEdge(edge: Edge, time: number) {
		const next = setRangeEdge(range, edge, time, duration);
		if (next.start === range.start && next.end === range.end) return;
		range = next;
		onscrub?.(edge, next[edge]);
	}

	function keydown(edge: Edge, event: KeyboardEvent) {
		if (disabled) return;
		const target = edgeTarget(event, range, edge, span, duration, pictures);
		if (target === undefined) return;
		event.preventDefault();
		setEdge(edge, target);
		reveal(...thumbTimes(edge, event.currentTarget as HTMLElement));
	}

	/**
	 * An end's thumb: moves the end as far as the pointer moves. The thumb stands beside
	 * its time, not on it, so taking the time under the pointer would make it jump.
	 */
	function grabEdge(edge: Edge, event: PointerEvent) {
		if (disabled || event.button !== 0) return;
		event.stopPropagation();
		focusPressed(event.currentTarget as HTMLElement);
		const from = range[edge];
		const origin = timeAt(event.clientX);
		followPointer(event, (e) => setEdge(edge, from + timeAt(e.clientX) - origin));
	}

	/** The whole range shifted by `delta` seconds, its length kept; its first frame shown. */
	function moveBy(delta: number, from = range) {
		const next = moveRange(from, delta, duration);
		if (next.start === range.start) return;
		range = next;
		onscrub?.('start', next.start);
	}

	function moveKeydown(event: KeyboardEvent) {
		if (disabled) return;
		const delta = moveDelta(event, range.start, duration, pictures);
		if (delta === undefined) return;
		event.preventDefault();
		moveBy(delta);
		reveal(range.end, range.start);
	}

	/** The selection, or the tab under it: drags the whole range along the track. */
	function grabRange(event: PointerEvent, focus = false) {
		if (disabled || event.button !== 0) return;
		event.stopPropagation();
		if (focus) focusPressed(event.currentTarget as HTMLElement);
		const from = range;
		const origin = timeAt(event.clientX);
		followPointer(event, (e) => moveBy(timeAt(e.clientX) - origin, from));
	}

	/** Pressing the bare track brings the nearer edge there, to drag on. */
	function grabTrack(event: PointerEvent) {
		if (disabled || event.button !== 0) return;
		const time = timeAt(event.clientX);
		const edge: Edge = Math.abs(time - range.start) <= Math.abs(time - range.end) ? 'start' : 'end';
		setEdge(edge, time);
		followPointer(event, (e) => setEdge(edge, timeAt(e.clientX)));
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- Pointer shortcuts only: the sliders inside do the same from the keyboard. -->
<div
	class="slider"
	class:disabled
	class:pictured={children}
	class:paired
	role="group"
	aria-label="Time range"
	style:--from="{left}%"
	style:--to="{right}%"
	bind:this={track}
	onpointerdown={grabTrack}
	{@attach observeSize((size) => (trackWidth = size.width))}
>
	{#if children}
		<!-- What the track shows: under the controls, clipped to its corners, in no pointer's way. -->
		<div class="layers" aria-hidden="true">
			{@render children()}
			<div class="dim" style:left="0" style:width="{left}%"></div>
			<div class="dim" style:left="{right}%" style:right="0"></div>
			{#if marked}
				<!-- Under the frames' marks, a darker band to read them on. -->
				<div class="band" style:left="{marked.left}%" style:width="{marked.width}%"></div>
			{/if}
		</div>
	{/if}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="selection"
		style:left="{left}%"
		style:width="{right - left}%"
		onpointerdown={(e) => grabRange(e)}
	></div>
	{#if playhead !== null && showing(playhead)}
		<!-- Over the range, clipped to the track's corners: at either end, none of it hangs past. -->
		<div class="layers" aria-hidden="true">
			<div class="playhead" style:left="{percent(playhead)}%"></div>
		</div>
	{/if}
	{#each EDGES as edge (edge)}
		<!--
			Inside the range, from its start or up to its end: never past the track's ends.
			Side by side, meeting at its middle, where the range is narrower than both.
			Out of view, still there for the keyboard, which brings it into view.
		-->
		<div
			class="thumb {edge}"
			class:outside={!showing(range[edge])}
			role="slider"
			tabindex={disabled ? -1 : 0}
			aria-label={LABEL[edge]}
			aria-valuemin={edge === 'start' ? 0 : range.start + span}
			aria-valuemax={edge === 'start' ? range.end - span : duration}
			aria-valuenow={range[edge]}
			aria-valuetext={formatClipTime(range[edge])}
			aria-disabled={disabled}
			onfocus={(e) => focused(...thumbTimes(edge, e.currentTarget))}
			onkeydown={(e) => keydown(edge, e)}
			onpointerdown={(e) => grabEdge(edge, e)}
		></div>
	{/each}
	{#if marks && marked}
		<!--
			Over the thumbs, so the range's first and last frames show their marks too:
			clipped to the track's corners, in no pointer's way.
		-->
		<div class="layers over" aria-hidden="true">
			<div
				class="marks"
				data-frames={marks.count}
				style:left="{marked.left}%"
				style:width="{marked.width}%"
				style:--frames={marks.count}
			></div>
		</div>
	{/if}
	<!-- A tab hanging under the middle of the range (of what shows of it): drags the whole range. -->
	<div
		class="tab"
		class:outside={right <= left}
		role="slider"
		tabindex={disabled ? -1 : 0}
		aria-label="Move the range"
		aria-valuemin={0}
		aria-valuemax={latest}
		aria-valuenow={range.start}
		aria-valuetext="{formatClipTime(range.start)} to {formatClipTime(range.end)}"
		aria-disabled={disabled}
		style:--middle="{(left + right) / 2}%"
		onfocus={() => focused(range.end, range.start)}
		onkeydown={moveKeydown}
		onpointerdown={(e) => grabRange(e, true)}
	></div>
</div>

<style>
	.slider {
		--tab-height: 1.2rem;
		position: relative;
		height: 2.75rem;
		/* Room below for the tab, which hangs from the track. */
		margin: 0 0.5rem var(--tab-height);
		border-radius: 8px;
		/* An inset shadow, not a border: positions are percentages of the box the pointer maps to. */
		box-shadow: inset 0 0 0 1px var(--border);
		background: var(--surface-2);
		cursor: pointer;
		touch-action: none;
		user-select: none;
	}

	.layers {
		position: absolute;
		inset: 0;
		overflow: hidden;
		border-radius: inherit;
		pointer-events: none;
	}

	.dim {
		position: absolute;
		top: 0;
		bottom: 0;
		background: rgb(0 0 0 / 0.55);
	}

	/* The marks over the thumbs: later than they are, at their level. */
	.over {
		z-index: 1;
	}

	.marks,
	.band {
		position: absolute;
		bottom: 3px;
		height: 0.45rem;
	}

	/*
	 * A short line where each frame is taken, along the bottom: one gradient over
	 * the whole stretch, not a tiled one, whose tiles browsers round to whole pixels.
	 */
	.marks {
		--mark: var(--accent);
		background-image: repeating-linear-gradient(
			to right,
			var(--mark) 0 1px,
			transparent 1px calc(100% / var(--frames))
		);
	}

	.pictured .marks {
		--mark: #fff;
	}

	.band {
		background: rgb(0 0 0 / 0.4);
	}

	.selection {
		position: absolute;
		top: 0;
		bottom: 0;
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		box-shadow:
			inset 0 2px 0 var(--accent),
			inset 0 -2px 0 var(--accent);
		cursor: grab;
	}

	/* Over pictures, the range is seen through: outlined, not tinted. */
	.pictured .selection {
		background: none;
		box-shadow:
			inset 0 3px 0 var(--accent),
			inset 0 -3px 0 var(--accent);
	}

	.playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		margin-left: -1px;
		background: var(--text);
		opacity: 0.7;
	}

	.pictured .playhead {
		background: #fff;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.45);
		opacity: 0.9;
	}

	/*
	 * Each end's thumb stands inside the range, its outer edge where the range starts or
	 * ends (`--from`, `--to`): at the track's ends it is flush with them, never hanging
	 * past. An end alone on the track (the other out of view) is kept on it.
	 */
	.thumb {
		--width: var(--timeline-thumb);
		position: absolute;
		top: -0.3rem;
		bottom: -0.3rem;
		width: var(--width);
		border-radius: 4px;
		background: var(--accent);
		cursor: ew-resize;
		touch-action: none;
		/* Over the tab where a short range brings them together: the edges stay in reach. */
		z-index: 1;
	}

	.thumb.start {
		left: min(var(--from), 100% - var(--width));
	}

	.thumb.end {
		left: max(var(--to) - var(--width), 0px);
	}

	/*
	 * Both on the track: a range narrower than the two thumbs sets them side by side,
	 * meeting at its middle, the start's first — kept on the track, so near either of
	 * its ends they meet off the middle. Wider, these are the rules above.
	 */
	.paired .thumb.start {
		left: clamp(
			0px,
			min(var(--from), (var(--from) + var(--to)) / 2 - var(--width)),
			100% - 2 * var(--width)
		);
	}

	.paired .thumb.end {
		left: clamp(
			var(--width),
			max(var(--to) - var(--width), (var(--from) + var(--to)) / 2),
			100% - var(--width)
		);
	}

	/* Fingers need more than the thumb shows: a wider, invisible grip around it. */
	@media (pointer: coarse) {
		.thumb::before {
			content: '';
			position: absolute;
			inset: 0 -0.6rem;
		}
	}

	/* A grip: two short lines down the middle. */
	.thumb::after {
		content: '';
		position: absolute;
		inset: 35% 30%;
		border-inline: 2px solid var(--accent-text);
		opacity: 0.8;
	}

	/*
	 * A tab hanging from the range's lower edge, under its middle — kept within the
	 * track at either end, where the middle of a short range comes close to the edge.
	 */
	.tab {
		--half: 1.375rem;
		position: absolute;
		top: 100%;
		left: clamp(var(--half), var(--middle), calc(100% - var(--half)));
		width: calc(2 * var(--half));
		height: var(--tab-height);
		margin-left: calc(-1 * var(--half));
		border-radius: 0 0 6px 6px;
		background: var(--accent);
		cursor: grab;
		touch-action: none;
	}

	.tab:active {
		cursor: grabbing;
	}

	/* Fingers: a grip reaching past the tab, mostly below it, where nothing else is. */
	@media (pointer: coarse) {
		.tab::before {
			content: '';
			position: absolute;
			inset: 0 -0.5rem -0.6rem;
		}
	}

	/* A grip: three short upright lines in the middle. */
	.tab::after {
		content: '';
		position: absolute;
		top: 25%;
		bottom: 30%;
		left: 50%;
		width: 12px;
		margin-left: -6px;
		background: repeating-linear-gradient(to right, var(--accent-text) 0 2px, transparent 2px 5px);
		opacity: 0.8;
	}

	/* An end, or the whole range, outside what the zoomed track shows. */
	.outside {
		opacity: 0;
		pointer-events: none;
	}

	.disabled {
		opacity: 0.6;
		cursor: default;
	}

	.disabled .selection,
	.disabled .thumb,
	.disabled .tab {
		cursor: default;
	}
</style>
