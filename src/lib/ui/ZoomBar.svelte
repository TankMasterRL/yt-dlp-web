<script lang="ts">
	import {
		MIN_VIEW,
		formatClipTime,
		moveRange,
		setRangeEdge,
		type TimeRange
	} from '$lib/animate/clip';
	import { followPointer } from './drag';
	import { edgeTarget } from './slider-keys';

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

	function grabEdge(edge: Edge, event: PointerEvent) {
		if (event.button !== 0) return;
		event.stopPropagation();
		(event.currentTarget as HTMLElement).focus();
		followPointer(event, (e) => setEdge(edge, timeAt(e.clientX)));
	}

	/**
	 * Between the ends: moves the stretch shown along the video, as long as it is. Showing
	 * all of it, there is nowhere to move: the press is the bar's, and zooms in.
	 */
	function grabStretch(event: PointerEvent) {
		if (event.button !== 0 || !zoomed) return;
		event.stopPropagation();
		const from = shown;
		const origin = timeAt(event.clientX);
		followPointer(event, (e) => {
			const next = moveRange(from, timeAt(e.clientX) - origin, duration);
			if (next.start !== shown.start) view = next;
		});
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
<!-- Pointer shortcuts only: the two sliders inside do the same from the keyboard. -->
<div
	class="zoom"
	class:zoomed
	role="group"
	aria-label="Timeline zoom"
	title="Drag the ends to zoom the timeline in; drag between them to move along the video"
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
		onpointerdown={grabStretch}
	></div>
	{#each EDGES as edge (edge)}
		<div
			class="handle {edge}"
			role="slider"
			tabindex="0"
			aria-label={LABEL[edge]}
			aria-valuemin={edge === 'start' ? 0 : shown.start + span}
			aria-valuemax={edge === 'start' ? shown.end - span : duration}
			aria-valuenow={shown[edge]}
			aria-valuetext={formatClipTime(shown[edge])}
			style:left="{percent(shown[edge])}%"
			onkeydown={(e) => keydown(edge, e)}
			onpointerdown={(e) => grabEdge(edge, e)}
		></div>
	{/each}
</div>

<style>
	.zoom {
		position: relative;
		height: 1.25rem;
		margin: 0 0.5rem;
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

	.handle {
		position: absolute;
		top: -0.2rem;
		bottom: -0.2rem;
		width: 0.75rem;
		margin-left: -0.375rem;
		border-radius: 3px;
		background: var(--muted);
		cursor: ew-resize;
		touch-action: none;
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
</style>
