// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

interface ImportMetaEnv {
	/** Origin of the relay Worker; unset means same-origin (all-in-one deploy). */
	readonly VITE_RELAY_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

export {};
