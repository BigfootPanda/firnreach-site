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
			description: 'The official Firnreach wiki: buildings, enemies, skills, the Hollow and how to play.',
			favicon: '/favicon.svg',
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
						{ label: 'Controls', slug: 'wiki/controls' },
						{ label: 'Difficulty and match settings', slug: 'wiki/match-settings' },
					],
				},
				{
					label: 'Almanac',
					items: [
						{ label: 'Player', slug: 'wiki/player' },
						{ label: 'Buildings', collapsed: true, items: [{ autogenerate: { directory: 'wiki/towers' } }] },
						{ label: 'Enemies and bosses', collapsed: true, items: [{ autogenerate: { directory: 'wiki/enemies' } }] },
						{ label: 'Relics', slug: 'wiki/relics' },
						{ label: 'Crystals and resources', slug: 'wiki/resources' },
					],
				},
				{
					label: 'Progression',
					items: [
						{ label: 'Skill tree', collapsed: true, items: [{ autogenerate: { directory: 'wiki/skills' } }] },
						{ label: 'The Hollow', collapsed: true, items: [{ autogenerate: { directory: 'wiki/hollow' } }] },
						{ label: 'The pick', slug: 'wiki/picks' },
						{ label: 'Achievements', slug: 'wiki/achievements' },
					],
				},
			],
		}),
	],
});
