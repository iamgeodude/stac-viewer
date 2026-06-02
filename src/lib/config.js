import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'stac-api-url';

// A sensible public default so the app shows data out of the box.
// "Kentucky From Above" STAC API (stac-fastapi), CORS-enabled.
export const DEFAULT_API_URL = 'https://spved5ihrl.execute-api.us-west-2.amazonaws.com';

function initialUrl() {
	if (browser) {
		const saved = window.localStorage.getItem(STORAGE_KEY);
		if (saved) return saved;
	}
	return DEFAULT_API_URL;
}

/** The STAC API root URL, persisted to localStorage. */
export const apiUrl = writable(initialUrl());

if (browser) {
	apiUrl.subscribe((value) => {
		if (value) window.localStorage.setItem(STORAGE_KEY, value);
	});
}
