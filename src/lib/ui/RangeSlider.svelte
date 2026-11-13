<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		MIN_SPAN,
		formatClipTime,
		frameMarks,
		moveRange,
		setRangeEdge,
		type TimeRange
	} from '$lib/animate/clip';
	import { followPointer } from './drag';
	import { observeSize } from './size';

	type Edge = 'start' | 'end';

	interface Props {
		range: TimeRange;
		/** Seconds. */
		duration: number;
		/** Where the preview is, marked on the track. */
		playhead?: number | null;
		disabled?: boolean;
		/** Someone moved an edge: `time` is where it is now (to show the frame there). */
		onscrub?: (edge: Edge, time: number) => void;
		/** The animation's frame rate: where they stand apart, its frames are marked on the range. */
		fps?: number | null;
		/** Pictures across the whole track (the frame timeline), darkened outside the range. */
		children?: Snippet;
	}

	let {
		range = $bindable(),
		duration,
		playhead = null,
		disabled = false,
		onscrub,
		fps = null,
		children
	}: Props = $props();

	const STEP = 0.1;
	const BIG_STEP = 1;
	const EDGES: Edge[] = ['start', 'end'];
	const LABEL: Record<Edge, string> = { start: 'Start', end: 'End' };

	let track: HTMLDivElement;
	/** CSS pixels; 0 until laid out. */
	let trackWidth = $state(0);
	const span = $derived(Math.min(MIN_SPAN, duration));
	const marks = $derived(fps ? frameMarks(range, fps, duration, trackWidth) : null);
	/** As late as the range can start, its length kept. */
	const latest = $derived(moveRange(range, duration, duration).start);
	const percent = (time: number) => (duration > 0 ? (time / duration) * 100 : 0);

	function timeAt(clientX: number): number {
		const rect = track.getBoundingClientRect();
		return rect.width ? ((clientX - rect.left) / rect.width) * duration : 0;
	}

	function setEdge(edge: Edge, time: number) {
		const next = setRangeEdge(range, edge, time, duration);
		if (next.start === range.start && next.end === range.end) return;
		range = next;
		onscrub?.(edge, next[edge]);
	}

	function keydown(edge: Edge, event: KeyboardEvent) {
		if (disabled) return;
		const value = range[edge];
		const step = event.shiftKey ? BIG_STEP : STEP;
		const targets: Record<string, number> = {
			ArrowLeft: value - step,
			ArrowDown: value - step,
			ArrowRight: value + step,
			ArrowUp: value + step,
			PageDown: value - BIG_STEP,
			PageUp: value + BIG_STEP,
			Home: edge === 'start' ? 0 : range.start + span,
			End: edge === 'start' ? range.end - span : duration
		};
		if (!(event.key in targets)) return;
		event.preventDefault();
		setEdge(edge, targets[event.key]);
	}

	function grabEdge(edge: Edge, event: PointerEvent) {
		if (disabled || event.button !== 0) return;
		event.stopPropagation();
		(event.currentTarget as HTMLElement).focus();
		followPointer(event, (e) => setEdge(edge, timeAt(e.clientX)));
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
		const step = event.shiftKey ? BIG_STEP : STEP;
		const deltas: Record<string, number> = {
			ArrowLeft: -step,
			ArrowDown: -step,
			ArrowRight: step,
			ArrowUp: step,
			PageDown: -BIG_STEP,
			PageUp: BIG_STEP,
			Home: -duration,
			End: duration
		};
		if (!(event.key in deltas)) return;
		event.preventDefault();
		moveBy(deltas[event.key]);
	}

	/** The selection, or the tab under it: drags the whole range along the track. */
	function grabRange(event: PointerEvent, focus = false) {
		if (disabled || event.button !== 0) return;
		event.stopPropagation();
		if (focus) (event.currentTarget as HTMLElement).focus();
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
	role="group"
	aria-label="Time range"
	bind:this={track}
	onpointerdown={grabTrack}
	{@attach observeSize((size) => (trackWidth = size.width))}
>
	{#if children || marks}
		<!-- What the track shows: under the controls, clipped to its corners, in no pointer's way. -->
		<div class="layers" aria-hidden="true">
			{#if children}
				{@render children()}
				<div class="dim" style:left="0" style:width="{percent(range.start)}%"></div>
				<div class="dim" style:left="{percent(range.end)}%" style:right="0"></div>
			{/if}
			{#if marks}
				<div
					class="marks"
					data-frames={marks.count}
					style:left="{percent(marks.start)}%"
					style:width="{percent(marks.length)}%"
					style:--frames={marks.count}
				></div>
			{/if}
		</div>
	{/if}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="selection"
		style:left="{percent(range.start)}%"
		style:width="{percent(range.end - range.start)}%"
		onpointerdown={(e) => grabRange(e)}
	></div>
	{#if playhead !== null}
		<div class="playhead" style:left="{percent(playhead)}%" aria-hidden="true"></div>
	{/if}
	{#each EDGES as edge (edge)}
		<div
			class="thumb {edge}"
			role="slider"
			tabindex={disabled ? -1 : 0}
			aria-label={LABEL[edge]}
			aria-valuemin={edge === 'start' ? 0 : range.start + span}
			aria-valuemax={edge === 'start' ? range.end - span : duration}
			aria-valuenow={range[edge]}
			aria-valuetext={formatClipTime(range[edge])}
			aria-disabled={disabled}
			style:left="{percent(range[edge])}%"
			onkeydown={(e) => keydown(edge, e)}
			onpointerdown={(e) => grabEdge(edge, e)}
		></div>
	{/each}
	<!-- A tab hanging under the middle of the range: drags the whole range, its length kept. -->
	<div
		class="tab"
		role="slider"
		tabindex={disabled ? -1 : 0}
		aria-label="Move the range"
		aria-valuemin={0}
		aria-valuemax={latest}
		aria-valuenow={range.start}
		aria-valuetext="{formatClipTime(range.start)} to {formatClipTime(range.end)}"
		aria-disabled={disabled}
		style:--middle="{percent((range.start + range.end) / 2)}%"
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

	/*
	 * A short line where each frame is taken, along the bottom: one gradient over
	 * the whole stretch, not a tiled one, whose tiles browsers round to whole pixels.
	 */
	.marks {
		--mark: var(--accent);
		position: absolute;
		bottom: 3px;
		height: 0.45rem;
		background-image: repeating-linear-gradient(
			to right,
			var(--mark) 0 1px,
			transparent 1px calc(100% / var(--frames))
		);
	}

	.pictured .marks {
		--mark: #fff;
		background-color: rgb(0 0 0 / 0.4);
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
		pointer-events: none;
	}

	.pictured .playhead {
		background: #fff;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.45);
		opacity: 0.9;
	}

	.thumb {
		position: absolute;
		top: -0.3rem;
		bottom: -0.3rem;
		width: 0.9rem;
		margin-left: -0.45rem;
		border-radius: 4px;
		background: var(--accent);
		cursor: ew-resize;
		touch-action: none;
		/* Over the tab where a short range brings them together: the edges stay in reach. */
		z-index: 1;
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
