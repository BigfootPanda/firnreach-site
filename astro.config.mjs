// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Static build (dist/) served by a Cloudflare Worker with static assets - see wrangler.jsonc.
export default defineConfig({
	site: 'https://firnreach.com',
	trailingSlash: 'ignore',
	integrations: [
		starlight({
			title: 'Firnreach',
			description: 'The official Firnreach wiki: towers, enemies, and how to play.',
			favicon: '/favicon.svg',
			// Private preview: keep out of search engines until launch.
			head: [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' } }],
			customCss: [
				'@fontsource/barlow/400.css',
				'@fontsource/barlow/500.css',
				'@fontsource/barlow/600.css',
				'@fontsource/barlow-condensed/500.css',
				'@fontsource/barlow-condensed/600.css',
				'./src/styles/tokens.css',
				'./src/styles/starlight.css',
			],
			components: {
				SocialIcons: './src/components/NavLinks.astro',
			},
			// Official wiki only for now: no "edit this page" links, no community edits.
			lastUpdated: false,
			pagination: true,
			sidebar: [
				{ label: 'Wiki home', slug: 'wiki' },
				{
					label: 'Guides',
					items: [
						{ label: 'Getting started', slug: 'wiki/getting-started' },
						{ label: 'Playing together online', slug: 'wiki/playing-online' },
					],
				},
				{ label: 'Towers', collapsed: true, items: [{ autogenerate: { directory: 'wiki/towers' } }] },
				{ label: 'Enemies', collapsed: true, items: [{ autogenerate: { directory: 'wiki/enemies' } }] },
			],
		}),
	],
});
