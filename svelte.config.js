import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// SPA mode: render a single fallback page and do all routing client-side.
		adapter: adapter({
			fallback: 'index.html'
		}),
		// Dynamic [id] routes can't be prerendered in a pure SPA, so disable it globally.
		prerender: { entries: [] }
	}
};

export default config;
