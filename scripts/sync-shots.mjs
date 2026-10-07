#!/usr/bin/env node
/**
 * sync-shots.mjs - copy captured game shots into the site (resized), with their alt text.
 *
 *   node scripts/sync-shots.mjs [--from "E:/Game Making/firnreach-site-shots"]
 *
 * Source layout (any of these may be missing):
 *   <from>/enemies/<name>.png   -> src/assets/wiki/enemies/<slug>.png   (wiki entry art)
 *   <from>/towers/<name>.png    -> src/assets/wiki/towers/<slug>.png
 *   <from>/<section>/<name>.png -> src/assets/wiki/<section>/<slug>.png (skills, hollow, resources, ...)
 *   <from>/*.png, <from>/home/*.png -> src/assets/shots/<name>.png     (home page: hero-*, commander-*, gallery)
 *   <from>/manifest.json        - alt text. Accepted shapes: { "<rel path>": "alt" }, { "<rel path>": { alt } },
 *                                 [ { file|path|name, alt } ], or { shots|items|files: [ ... ] }.
 *
 * <name> may already be the wiki slug ("frost-mite"), the game's key ("FrostMite") or the display name
 * ("Frost Mite"); it is matched against src/data/game.json. Images are resized to at most 1600 px wide (astro:assets
 * makes the responsive sizes at build time). Alt text lands in src/assets/wiki/alt.json and src/assets/shots/alt.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const i = args.indexOf('--from');
const FROM = resolve(i >= 0 ? args[i + 1] : join(ROOT, '..', 'firnreach-site-shots'));
if (!existsSync(FROM)) {
	console.log(`No shots folder at ${FROM}; nothing to do.`);
	process.exit(0);
}

const game = JSON.parse(readFileSync(join(ROOT, 'src/data/game.json'), 'utf8'));
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const unCamel = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2');
const SECTION_ALIASES = { buildings: 'towers', tower: 'towers', enemy: 'enemies', bosses: 'enemies', boss: 'enemies' };

// name -> slug lookups per section
const known = {
	towers: new Map(game.towers.flatMap((t) => [[slugify(t.name), t.slug], [String(t.id), t.slug]])),
	enemies: new Map(game.enemies.flatMap((e) => [[slugify(e.name), e.slug], [slugify(unCamel(e.key)), e.slug], [slugify(e.short || ''), e.slug]])),
};
const resolveSlug = (section, name) => {
	const s = slugify(unCamel(name.replace(/^(T_UI_(Enemy|Tower)_|SM_|enemy[-_]|tower[-_])/i, '')));
	return known[section]?.get(s) ?? known[section]?.get(slugify(name)) ?? s;
};

// ---- manifest
const alts = {};
const mf = join(FROM, 'manifest.json');
if (existsSync(mf)) {
	const m = JSON.parse(readFileSync(mf, 'utf8'));
	const list = Array.isArray(m) ? m : Array.isArray(m.shots) ? m.shots : Array.isArray(m.items) ? m.items : Array.isArray(m.files) ? m.files : null;
	if (list) for (const e of list) { const f = e.file || e.path || e.name; if (f && e.alt) alts[f.replace(/\\/g, '/')] = e.alt; }
	else for (const [k, v] of Object.entries(m)) { const a = typeof v === 'string' ? v : v?.alt; if (a) alts[k.replace(/\\/g, '/')] = a; }
}
const altFor = (rel) => alts[rel] ?? alts[basename(rel)] ?? alts[rel.replace(extname(rel), '')] ?? null;

const IMG = /\.(png|jpe?g|webp)$/i;
async function copyResized(src, dest) {
	mkdirSync(dirname(dest), { recursive: true });
	await sharp(src).resize({ width: 1600, withoutEnlargement: true }).png({ compressionLevel: 9, palette: false }).toFile(dest);
}

const wikiAltPath = join(ROOT, 'src/assets/wiki/alt.json');
const shotAltPath = join(ROOT, 'src/assets/shots/alt.json');
const wikiAlts = existsSync(wikiAltPath) ? JSON.parse(readFileSync(wikiAltPath, 'utf8')) : {};
const shotAlts = existsSync(shotAltPath) ? JSON.parse(readFileSync(shotAltPath, 'utf8')) : {};
let nWiki = 0, nHome = 0;

for (const entry of readdirSync(FROM)) {
	const p = join(FROM, entry);
	if (statSync(p).isDirectory()) {
		if (entry === 'home') {
			for (const f of readdirSync(p).filter((x) => IMG.test(x))) {
				const out = `${slugify(f.replace(IMG, ''))}.png`;
				await copyResized(join(p, f), join(ROOT, 'src/assets/shots', out));
				const a = altFor(`home/${f}`); if (a) shotAlts[out] = a;
				nHome++;
			}
			continue;
		}
		const section = SECTION_ALIASES[entry.toLowerCase()] || entry.toLowerCase();
		for (const f of readdirSync(p).filter((x) => IMG.test(x))) {
			const slug = resolveSlug(section, f.replace(IMG, ''));
			await copyResized(join(p, f), join(ROOT, 'src/assets/wiki', section, `${slug}.png`));
			const a = altFor(`${entry}/${f}`); if (a) wikiAlts[`${section}/${slug}`] = a;
			nWiki++;
		}
	} else if (IMG.test(entry)) {
		const out = `${slugify(entry.replace(IMG, ''))}.png`;
		await copyResized(p, join(ROOT, 'src/assets/shots', out));
		const a = altFor(entry); if (a) shotAlts[out] = a;
		nHome++;
	}
}
if (nWiki) { mkdirSync(dirname(wikiAltPath), { recursive: true }); writeFileSync(wikiAltPath, JSON.stringify(wikiAlts, null, '\t') + '\n'); }
if (nHome) { mkdirSync(dirname(shotAltPath), { recursive: true }); writeFileSync(shotAltPath, JSON.stringify(shotAlts, null, '\t') + '\n'); }
console.log(`sync-shots: ${nWiki} wiki images, ${nHome} home page shots from ${FROM}`);
