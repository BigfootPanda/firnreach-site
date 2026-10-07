// Firnreach site worker: serves the static Astro build (dist/) and sends firnreach.dev and
// www.firnreach.com to https://firnreach.com (same path and query). Everything else is a static asset.
const CANONICAL = 'firnreach.com';
const REDIRECT_HOSTS = new Set(['firnreach.dev', 'www.firnreach.dev', 'www.firnreach.com']);

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (REDIRECT_HOSTS.has(url.hostname)) {
			url.hostname = CANONICAL;
			url.protocol = 'https:';
			url.port = '';
			return Response.redirect(url.toString(), 301);
		}
		return env.ASSETS.fetch(request);
	},
};
