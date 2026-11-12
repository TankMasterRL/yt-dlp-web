<script lang="ts">
	import {
		MIN_SPAN,
		formatClipTime,
		moveRange,
		setRangeEdge,
		type TimeRange
	} from '$lib/animate/clip';
	import { followPointer } from './drag';

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
	}

	let {
		range = $bindable(),
		duration,
		playhead = null,
		disabled = false,
		onscrub
	}: Props = $props();

	const STEP = 0.1;
	const BIG_STEP = 1;
	const EDGES: Edge[] = ['start', 'end'];
	const LABEL: Record<Edge, string> = { start: 'Start', end: 'End' };

	let track: HTMLDivElement;
	const span = $derived(Math.min(MIN_SPAN, duration));
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

	function grabSelection(event: PointerEvent) {
		if (disabled || event.button !== 0) return;
		event.stopPropagation();
		const from = range;
		const origin = timeAt(event.clientX);
		followPointer(event, (e) => {
			const next = moveRange(from, timeAt(e.clientX) - origin, duration);
			if (next.start === range.start) return;
			range = next;
			onscrub?.('start', next.start);
		});
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
<!-- Pointer shortcuts only: the two sliders inside do the same from the keyboard. -->
<div
	class="slider"
	class:disabled
	role="group"
	aria-label="Time range"
	bind:this={track}
	onpointerdown={grabTrack}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="selection"
		style:left="{percent(range.start)}%"
		style:width="{percent(range.end - range.start)}%"
		onpointerdown={grabSelection}
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
</div>

<style>
	.slider {
		position: relative;
		height: 2.75rem;
		margin: 0 0.5rem;
		border-radius: 8px;
		/* An inset shadow, not a border: positions are percentages of the box the pointer maps to. */
		box-shadow: inset 0 0 0 1px var(--border);
		background: var(--surface-2);
		cursor: pointer;
		touch-action: none;
		user-select: none;
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

	.disabled {
		opacity: 0.6;
		cursor: default;
	}

	.disabled .selection,
	.disabled .thumb {
		cursor: default;
	}
</style>
