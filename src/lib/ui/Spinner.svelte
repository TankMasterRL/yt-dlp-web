<!--
	A busy sign, beside words that say what is happening (it says nothing itself).
	It turns by transform alone, which the compositor animates: it keeps turning
	smoothly however busy the page's own thread is.
-->
<span class="spinner" aria-hidden="true"></span>

<style>
	.spinner {
		display: inline-block;
		flex: none;
		width: 0.9em;
		height: 0.9em;
		margin-right: 0.4em;
		vertical-align: -0.12em;
		border: 0.15em solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		animation: turn 0.8s linear infinite;
	}

	@keyframes turn {
		to {
			transform: rotate(1turn);
		}
	}

	/* Still there, without the motion: a slow fade, also the compositor's. */
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			border-right-color: currentColor;
			animation: fade 1.6s ease-in-out infinite alternate;
		}
	}

	@keyframes fade {
		from {
			opacity: 0.25;
		}
	}
</style>
