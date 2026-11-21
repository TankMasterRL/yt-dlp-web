<script lang="ts">
	import {
		MIN_VIEW,
		formatClipTime,
		moveRange,
		setRangeEdge,
		type TimeRange
	} from '#lib/animate/clip.ts';
	import { followPointer } from './drag';
	import { edgeTarget, moveDelta } from './slider-keys';

	type Edge = 'start' | 'end';

	interface Props {
		/** The stretch of the video the frame timeline shows (null: all of it). */
		view: TimeRange | null;
		/** Seconds. */
		duration: number;
		/** The animation's time range, marked where it is in the whole video. */
		range: TimeRange;
	}

	let { view = $bindable(null), duration, range }: Props = $props();

	const EDGES: Edge[] = ['start', 'end'];
	const LABEL: Record<Edge, string> = { start: 'Zoom from', end: 'Zoom to' };

	let bar: HTMLDivElement;
	const shown = $derived(view ?? { start: 0, end: duration });
	const zoomed = $derived(shown.start > 0 || shown.end < duration);
	const span = $derived(Math.min(MIN_VIEW, duration));
	/** As late as the stretch can start, its length kept. */
	const latest = $derived(moveRange(shown, duration, duration).start);
	const percent = (time: number) => (duration > 0 ? (time / duration) * 100 : 0);

	function timeAt(clientX: number): number {
		const rect = bar.getBoundingClientRect();
		return rect.width ? ((clientX - rect.left) / rect.width) * duration : 0;
	}

	function setEdge(edge: Edge, time: number) {
		const next = setRangeEdge(shown, edge, time, duration, MIN_VIEW);
		if (next.start !== shown.start || next.end !== shown.end) view = next;
	}

	function keydown(edge: Edge, event: KeyboardEvent) {
		const target = edgeTarget(event, shown, edge, span, duration);
		if (target === undefined) return;
		event.preventDefault();
		setEdge(edge, target);
	}

	/**
	 * An end's handle: moves the end as far as the pointer moves. The handle stands beside
	 * its time, not on it, so taking the time under the pointer would make it jump.
	 */
	function grabEdge(edge: Edge, event: PointerEvent) {
		if (event.button !== 0) return;
		event.stopPropagation();
		(event.currentTarget as HTMLElement).focus();
		const from = shown[edge];
		const origin = timeAt(event.clientX);
		followPointer(event, (e) => setEdge(edge, from + timeAt(e.clientX) - origin));
	}

	/** The stretch shown moved `delta` seconds along the video, as long as it is. */
	function moveBy(delta: number, from = shown) {
		const next = moveRange(from, delta, duration);
		if (next.start !== shown.start) view = next;
	}

	function moveKeydown(event: KeyboardEvent) {
		const delta = moveDelta(event, shown.start, duration);
		if (delta === undefined) return;
		event.preventDefault();
		moveBy(delta);
	}

	/**
	 * Between the ends, or the tab under them: moves the stretch shown along the video.
	 * Showing all of it, there is nowhere to move: the press is the bar's, and zooms in.
	 */
	function grabStretch(event: PointerEvent, focus = false) {
		if (event.button !== 0 || !zoomed) return;
		event.stopPropagation();
		if (focus) (event.currentTarget as HTMLElement).focus();
		const from = shown;
		const origin = timeAt(event.clientX);
		followPointer(event, (e) => moveBy(timeAt(e.clientX) - origin, from));
	}

	/** Pressing the bare bar brings the nearer end there, to drag on. */
	function grabBar(event: PointerEvent) {
		if (event.button !== 0) return;
		const time = timeAt(event.clientX);
		const edge: Edge = Math.abs(time - shown.start) <= Math.abs(time - shown.end) ? 'start' : 'end';
		setEdge(edge, time);
		followPointer(event, (e) => setEdge(edge, timeAt(e.clientX)));
	}
</script>

<!--
	The whole video, under the frame timeline: its two ends choose the stretch the
	timeline shows, so a range can be set picture by picture.
-->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- Pointer shortcuts only: the sliders inside do the same from the keyboard. -->
<div
	class="zoom"
	class:zoomed
	role="group"
	aria-label="Timeline zoom"
	title="Drag the ends to zoom the timeline in; drag between them, or the tab under them, to move along the video"
	style:--from="{percent(shown.start)}%"
	style:--to="{percent(shown.end)}%"
	bind:this={bar}
	onpointerdown={grabBar}
>
	<div class="layers" aria-hidden="true">
		<div
			class="band"
			style:left="{percent(range.start)}%"
			style:width="{percent(range.end - range.start)}%"
		></div>
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="window"
		style:left="{percent(shown.start)}%"
		style:width="{percent(shown.end - shown.start)}%"
		onpointerdown={(e) => grabStretch(e)}
	></div>
	{#each EDGES as edge (edge)}
		<!--
			Inside the stretch, from its start or up to its end, as the time range's are:
			side by side, meeting at its middle, where the stretch is narrower than both.
		-->
		<div
			class="handle {edge}"
			role="slider"
			tabindex="0"
			aria-label={LABEL[edge]}
			aria-valuemin={edge === 'start' ? 0 : shown.start + span}
			aria-valuemax={edge === 'start' ? shown.end - span : duration}
			aria-valuenow={shown[edge]}
			aria-valuetext={formatClipTime(shown[edge])}
			onkeydown={(e) => keydown(edge, e)}
			onpointerdown={(e) => grabEdge(edge, e)}
		></div>
	{/each}
	{#if zoomed}
		<!--
			Zoomed in, a tab hanging under the middle of the stretch moves it along the video,
			however narrow it is: its handles may cover all of it.
		-->
		<div
			class="tab"
			role="slider"
			tabindex="0"
			aria-label="Move the zoom"
			aria-valuemin={0}
			aria-valuemax={latest}
			aria-valuenow={shown.start}
			aria-valuetext="{formatClipTime(shown.start)} to {formatClipTime(shown.end)}"
			style:--middle="{percent((shown.start + shown.end) / 2)}%"
			onkeydown={moveKeydown}
			onpointerdown={(e) => grabStretch(e, true)}
		></div>
	{/if}
</div>

<style>
	.zoom {
		--tab-height: 0.75rem;
		position: relative;
		height: 1.25rem;
		/* Room below for the tab, which hangs from the bar while zoomed in: kept, so nothing shifts. */
		margin: 0 0.5rem var(--tab-height);
		border-radius: 6px;
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

	/* The time range, a stripe in the accent of its own handles. */
	.band {
		position: absolute;
		top: 35%;
		bottom: 35%;
		min-width: 2px;
		border-radius: 2px;
		background: var(--accent);
	}

	/* The stretch the timeline shows: framed in a neutral tone, apart from the range's accent. */
	.window {
		position: absolute;
		top: 0;
		bottom: 0;
		border-radius: 4px;
		background: color-mix(in srgb, var(--muted) 14%, transparent);
		box-shadow: inset 0 0 0 2px var(--muted);
		cursor: grab;
	}

	/* Zoomed out, the frame is the whole bar, with nothing to drag along: a press zooms in. */
	.zoom:not(.zoomed) .window {
		background: none;
		cursor: inherit;
	}

	.zoomed .window:active {
		cursor: grabbing;
	}

	/*
	 * Each end's handle stands inside the stretch, its outer edge where the stretch starts
	 * or ends (`--from`, `--to`): at the bar's ends it is flush with them, in line with the
	 * time range's thumbs above, and as wide. A stretch narrower than the two sets them
	 * side by side, meeting at its middle, the start's first, kept on the bar — as the
	 * time range's thumbs do.
	 */
	.handle {
		--width: var(--timeline-thumb);
		position: absolute;
		top: -0.2rem;
		bottom: -0.2rem;
		width: var(--width);
		border-radius: 3px;
		background: var(--muted);
		cursor: ew-resize;
		touch-action: none;
	}

	.handle.start {
		left: clamp(
			0px,
			min(var(--from), (var(--from) + var(--to)) / 2 - var(--width)),
			100% - 2 * var(--width)
		);
	}

	.handle.end {
		left: clamp(
			var(--width),
			max(var(--to) - var(--width), (var(--from) + var(--to)) / 2),
			100% - var(--width)
		);
	}

	/* Fingers need more than the handle shows: a bigger, invisible grip around it. */
	@media (pointer: coarse) {
		.handle::before {
			content: '';
			position: absolute;
			inset: -0.3rem -0.6rem;
		}
	}

	/* A grip: two short lines down the middle, as on the range's ends. */
	.handle::after {
		content: '';
		position: absolute;
		inset: 32% 28%;
		border-inline: 2px solid var(--surface);
		opacity: 0.9;
	}

	/* The tab, as the time range's hangs from it: kept within the bar at either end. */
	.tab {
		--half: 1.1rem;
		position: absolute;
		top: 100%;
		left: clamp(var(--half), var(--middle), calc(100% - var(--half)));
		width: calc(2 * var(--half));
		height: var(--tab-height);
		margin-left: calc(-1 * var(--half));
		border-radius: 0 0 5px 5px;
		background: var(--muted);
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

	/* A grip: three short upright lines in the middle, as on the range's tab. */
	.tab::after {
		content: '';
		position: absolute;
		top: 22%;
		bottom: 28%;
		left: 50%;
		width: 12px;
		margin-left: -6px;
		background: repeating-linear-gradient(to right, var(--surface) 0 2px, transparent 2px 5px);
		opacity: 0.9;
	}
</style>
