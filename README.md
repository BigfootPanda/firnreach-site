# firnreach-site

The website and official wiki for **Firnreach**: marketing pages (home, news, FAQ) plus a
[Starlight](https://starlight.astro.build) wiki at `/wiki`, built with [Astro](https://astro.build) and served by a
Cloudflare Worker with static assets.

The site is **public** at https://firnreach.com.

## Develop

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # static build to dist/, then fails if the internal project name appears anywhere
npm run preview    # serve dist/ locally
```

## Game data (the wiki's Almanac pages, news)

The wiki mirrors what players see in game: the Almanac (PLAYER / BUILDINGS / ENEMIES / RELICS), the build menu, the
achievements screen, the trainer's skill tree, the Hollow's shops and stations, the pick, the match setup screen and
the default key bindings. All of it is generated from the game repo at a **release tag**, so unreleased changes
never reach the site:

```sh
npm run export-data                                   # newest vX.Y.Z tag in the game repo (sibling folder by default)
node scripts/export-game-data.mjs --tag v0.0.21       # a specific release
node scripts/export-game-data.mjs --repo "E:/path/to/game-repo"   # or set GAME_REPO
```

It writes (do not edit by hand):

- `src/data/game.json`, `src/data/news.json`
- `src/content/docs/wiki/{towers,enemies,skills,hollow}/*.mdx`
- `src/content/docs/wiki/{player,relics,achievements,resources,picks,match-settings,controls}.mdx`

`getting-started.md`, `playing-online.md` and `index.mdx` are hand-written. Commit the generated files: the site
builds without the game repo. Run this after each release export.

### Pictures

Entry pages lead with an Almanac-style card (`src/components/AlmanacCard.astro`). It shows a picture when
`src/assets/wiki/<section>/<slug>.png` exists (sections: `towers`, `enemies`, `skills`, `hollow`, `resources`) and
nothing otherwise; alt text comes from `src/assets/wiki/alt.json`. The home page picks up `src/assets/shots/`
(`hero-*` = hero background, `commander-*` = commander panel, everything else = gallery; alt text in
`src/assets/shots/alt.json`). To bring in a folder of captured shots (resized, alt text from its `manifest.json`):

```sh
npm run sync-shots                                    # from ../firnreach-site-shots
node scripts/sync-shots.mjs --from "E:/somewhere/else"
```

## Deploy (Cloudflare Workers static assets)

Config: `wrangler.jsonc` (worker `firnreach-site`, assets from `dist/`, `worker/index.js` redirects
`firnreach.dev` and `www.firnreach.com` to `https://firnreach.com`).

- `workers_dev` and `preview_urls` are **off**: the `*.workers.dev` URL is not behind Cloudflare Access.
- Custom domains are not in the config yet. Attach them only after Access covers them.

```sh
npm run build
npx wrangler deploy
```

## Going public (when the Steam page is live)

1. Remove the Access application for the domains.
2. Delete the two `Disallow` lines in `public/robots.txt` and the `noindex` meta tags (`src/layouts/Site.astro`,
   `astro.config.mjs` `head`).
3. Set `steamUrl` in `src/site.ts` so the home page shows the Wishlist button.
