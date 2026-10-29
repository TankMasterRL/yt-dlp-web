<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	let { children } = $props();

	const links = [
		{ href: resolve('/'), label: 'Download' },
		{ href: resolve('/library/'), label: 'Library' }
	];
</script>

<header>
	<a class="brand" href={resolve('/')}>yt-dlp<span>web</span></a>
	<nav aria-label="Main">
		{#each links as link (link.href)}
			<a href={link.href} aria-current={page.url.pathname === link.href ? 'page' : undefined}
				>{link.label}</a
			>
		{/each}
	</nav>
</header>

<main>
	{@render children()}
</main>

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem clamp(1rem, 4vw, 2rem);
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}

	.brand {
		font-weight: 800;
		font-size: 1.15rem;
		text-decoration: none;
		letter-spacing: -0.02em;
	}

	.brand span {
		color: var(--accent);
		margin-left: 0.15rem;
	}

	nav {
		display: flex;
		gap: 0.25rem;
	}

	nav a {
		text-decoration: none;
		padding: 0.35rem 0.75rem;
		border-radius: 8px;
		color: var(--muted);
	}

	nav a[aria-current='page'] {
		color: var(--text);
		background: var(--surface-2);
		font-weight: 600;
	}

	main {
		max-width: 64rem;
		margin: 0 auto;
		padding: clamp(1rem, 4vw, 2rem);
	}
</style>
