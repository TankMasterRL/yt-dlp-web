<script lang="ts">
	import { dragCrop, type CropHandle, type Rect, type Size } from '$lib/animate/clip';
	import { followPointer } from './drag';

	interface Props {
		/** In the video's own pixels. */
		crop: Rect;
		/** The video's size. */
		bounds: Size;
		disabled?: boolean;
	}

	let { crop = $bindable(), bounds, disabled = false }: Props = $props();

	type Resize = Exclude<CropHandle, 'move'>;
	const HANDLES: [Resize, string][] = [
		['n', 'top'],
		['ne', 'top right corner'],
		['e', 'right'],
		['se', 'bottom right corner'],
		['s', 'bottom'],
		['sw', 'bottom left corner'],
		['w', 'left'],
		['nw', 'top left corner']
	];
	const ARROWS: Record<string, [number, number]> = {
		ArrowLeft: [-1, 0],
		ArrowRight: [1, 0],
		ArrowUp: [0, -1],
		ArrowDown: [0, 1]
	};

	const uid = $props.id();
	let overlay: HTMLDivElement;
	const percent = (value: number, of: number) => `${(value / of) * 100}%`;
	/** A hundredth of the picture's width per key press; ten with Shift. */
	const step = $derived(Math.max(1, Math.round(bounds.width / 100)));

	function keydown(handle: CropHandle, event: KeyboardEvent) {
		const arrow = ARROWS[event.key];
		if (disabled || !arrow) return;
		event.preventDefault();
		const distance = event.shiftKey ? step * 10 : step;
		crop = dragCrop(crop, handle, arrow[0] * distance, arrow[1] * distance, bounds);
	}

	function grab(handle: CropHandle, event: PointerEvent) {
		if (disabled || event.button !== 0) return;
		const rect = overlay.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		(event.currentTarget as HTMLElement).focus();
		// Screen pixels to video pixels; every move measured from where the drag began.
		const [scaleX, scaleY] = [bounds.width / rect.width, bounds.height / rect.height];
		const [from, x, y] = [crop, event.clientX, event.clientY];
		followPointer(event, (e) => {
			crop = dragCrop(from, handle, (e.clientX - x) * scaleX, (e.clientY - y) * scaleY, bounds);
		});
	}
</script>

<div class="overlay" class:disabled bind:this={overlay}>
	<!-- The dimming is clipped to the picture; the handles on its edges are not. -->
	<div class="shade" aria-hidden="true">
		<div
			class="hole"
			style:left={percent(crop.x, bounds.width)}
			style:top={percent(crop.y, bounds.height)}
			style:width={percent(crop.width, bounds.width)}
			style:height={percent(crop.height, bounds.height)}
		></div>
	</div>
	<div
		class="box"
		style:left={percent(crop.x, bounds.width)}
		style:top={percent(crop.y, bounds.height)}
		style:width={percent(crop.width, bounds.width)}
		style:height={percent(crop.height, bounds.height)}
	>
		<button
			type="button"
			class="move"
			aria-label="Move the crop"
			aria-describedby="{uid}-hint"
			{disabled}
			onpointerdown={(e) => grab('move', e)}
			onkeydown={(e) => keydown('move', e)}
		></button>
		{#each HANDLES as [handle, where] (handle)}
			<button
				type="button"
				class="handle {handle}"
				aria-label="Resize the crop from the {where}"
				aria-describedby="{uid}-hint"
				{disabled}
				onpointerdown={(e) => grab(handle, e)}
				onkeydown={(e) => keydown(handle, e)}
			></button>
		{/each}
	</div>
	<span id="{uid}-hint" class="visually-hidden"
		>Drag it, or use the arrow keys; Shift for bigger steps.</span
	>
</div>

<style>
	.overlay {
		position: absolute;
		inset: 0;
		touch-action: none;
		user-select: none;
	}

	.shade {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.hole {
		position: absolute;
		/* Everything outside the crop, dimmed. */
		box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.55);
	}

	.box {
		position: absolute;
		outline: 1px solid rgb(255 255 255 / 0.9);
	}

	button {
		position: absolute;
		padding: 0;
		border-radius: 0;
		touch-action: none;
	}

	.move {
		inset: 0;
		border: 0;
		background: transparent;
		cursor: move;
		/* Thirds, to frame by. */
		background-image:
			linear-gradient(
				to right,
				transparent calc(100% / 3 - 0.5px),
				rgb(255 255 255 / 0.35) 0 calc(100% / 3 + 0.5px),
				transparent 0 calc(200% / 3 - 0.5px),
				rgb(255 255 255 / 0.35) 0 calc(200% / 3 + 0.5px),
				transparent 0
			),
			linear-gradient(
				to bottom,
				transparent calc(100% / 3 - 0.5px),
				rgb(255 255 255 / 0.35) 0 calc(100% / 3 + 0.5px),
				transparent 0 calc(200% / 3 - 0.5px),
				rgb(255 255 255 / 0.35) 0 calc(200% / 3 + 0.5px),
				transparent 0
			);
	}

	.move:focus-visible {
		outline-offset: -3px;
	}

	.handle {
		width: 1.1rem;
		height: 1.1rem;
		margin: -0.55rem 0 0 -0.55rem;
		border: 2px solid #111;
		background: #fff;
	}

	.n,
	.s {
		left: 50%;
		cursor: ns-resize;
	}
	.e,
	.w {
		top: 50%;
		cursor: ew-resize;
	}
	.n,
	.ne,
	.nw {
		top: 0;
	}
	.s,
	.se,
	.sw {
		top: 100%;
	}
	.w,
	.nw,
	.sw {
		left: 0;
	}
	.e,
	.ne,
	.se {
		left: 100%;
	}
	.ne,
	.sw {
		cursor: nesw-resize;
	}
	.nw,
	.se {
		cursor: nwse-resize;
	}

	.disabled button {
		cursor: default;
	}

	.disabled .handle {
		opacity: 0.5;
	}
</style>
