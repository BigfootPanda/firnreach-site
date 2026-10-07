#!/usr/bin/env node
/**
 * export-game-data.mjs - pull RELEASED, player-facing game data from the game repo into this site.
 *
 * Reads everything from a release tag (default: the newest vX.Y.Z tag) with `git show <tag>:<path>`,
 * so unreleased balance changes and work-in-progress content in the game repo can never leak onto the site.
 *
 * Sources (all at the tag):
 *   Balance/DT_Towers_live.csv, Balance/DT_Enemies_live.csv       - the DataTable exports (numbers)
 *   .../UI/FrostMenuScreens.cpp                                     - Almanac lists: which towers/enemies are
 *                                                                     player-facing, categories, lore, abilities
 *   .../UI/FrostBuildMenuBase.cpp                                   - one-line tower descriptions (build menu)
 *   .../Towers/FrostRimeVent.h                                      - Rime Vent slow numbers
 *   CHANGELOG.md                                                    - news / patch notes
 *
 * Writes:
 *   src/data/game.json                       - version + towers + enemies
 *   src/data/news.json                       - releases parsed from the changelog
 *   src/content/docs/wiki/towers/*.md        - one generated page per tower (+ index)
 *   src/content/docs/wiki/enemies/*.md       - one generated page per enemy (+ index)
 *
 * Usage:
 *   node scripts/export-game-data.mjs [--repo "E:/Game Making/Frostborn"] [--tag v0.0.20]
 *   (env GAME_REPO works too). Generated files are committed, so the site builds without the game repo.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const REPO = resolve(argVal('--repo') || process.env.GAME_REPO || join(ROOT, '..', 'Frostborn'));
const SRC = 'Frostborn-Unreal/Source/Frostborn';

// Public name only. The internal project name must never reach the site.
const INTERNAL_NAME = /frostborn/i;

// Towers that exist in the data but are not buildable in a released build. The Almanac list is the primary
// filter; this is a second guard (e.g. the Arc Blade is a dev-only weapon stand).
const HIDDEN_TOWER_IDS = new Set([24]);

const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function latestReleaseTag() {
	const tags = git('tag', '--list', 'v*', '--sort=-v:refname')
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
	if (!tags.length) throw new Error(`No vX.Y.Z release tag found in ${REPO}`);
	return tags[0];
}

const TAG = argVal('--tag') || latestReleaseTag();
const VERSION = TAG.replace(/^v/, '');
const show = (path) => git('show', `${TAG}:${path}`);
const tagDate = git('log', '-1', '--format=%cs', TAG).trim();

// ---------------------------------------------------------------- helpers

function parseCsv(text) {
	const rows = [];
	let row = [], cell = '', q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) {
			if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
			else if (c === '"') q = false;
			else cell += c;
		} else if (c === '"') q = true;
		else if (c === ',') { row.push(cell); cell = ''; }
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			row.push(cell); cell = '';
			if (row.some((x) => x !== '')) rows.push(row);
			row = [];
		} else cell += c;
	}
	if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
	const [head, ...body] = rows;
	head[0] = 'RowName';
	return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const num = (v) => (v === '' || v == null ? 0 : Number(v));
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
// The game abbreviates some building names to fit its build menu; the wiki spells them out (Alex, 2026-10-08).
const FULL_NAMES = {
	'H. Generator': 'Heat Generator',
	'D. Generator': 'Distribution Generator',
	'S. Projector': 'Shield Projector',
	'M. Siphon': 'Mana Siphon',
};
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cTextArgs = (s) => [...s.matchAll(/TEXT\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1].replace(/\\"/g, '"'));
const mdEscape = (s) => String(s).replace(/</g, '&lt;').replace(/\|/g, '\\|');
const yamlStr = (s) => JSON.stringify(String(s));

// Default key names for {ActionId} placeholders (Core/FrostKeyBindings.cpp defaults).
const KEYS = {
	TakeGun: 'Q', ShieldToggle: 'T', Aim: 'Right Mouse', FeedPower: 'F', AutoPower: 'V', Interact: 'E',
	Build: 'B', ToggleView: 'Tab', Upgrade: 'U', Sell: 'X', Rotate: 'R', Mine: 'Left Mouse', Jump: 'Space',
	Sprint: 'Left Shift', Ping: 'G', Surge: 'K', SkipDay: 'J', BaseMenu: 'Home', Chat: 'Enter', Pause: 'P',
};
const fmtKeys = (s) => s.replace(/\{(\w+)\}/g, (_, k) => KEYS[k] || k);

function block(text, startRe) {
	const start = text.search(startRe);
	if (start < 0) return '';
	const end = text.indexOf('};', start);
	return text.slice(start, end);
}

// ---------------------------------------------------------------- read sources at the tag

const menus = show(`${SRC}/UI/FrostMenuScreens.cpp`);
const build = show(`${SRC}/UI/FrostBuildMenuBase.cpp`);
const towerRows = parseCsv(show('Balance/DT_Towers_live.csv'));
const enemyRows = parseCsv(show('Balance/DT_Enemies_live.csv'));
const changelog = show('CHANGELOG.md');
let rime = '';
try { rime = show(`${SRC}/Towers/FrostRimeVent.h`); } catch { /* optional */ }

// Almanac tower list: { 10, TEXT("Defense"), TEXT("+HP, ...") }
const almanacTowers = [...block(menus, /const FAlmanacTower AlmanacTowers\[\]/).matchAll(/\{\s*(\d+)\s*,\s*TEXT\("([^"]*)"\)\s*,\s*TEXT\("([^"]*)"\)\s*\}/g)]
	.map((m) => ({ id: Number(m[1]), category: m[2], upgrades: m[3] }));
if (!almanacTowers.length) throw new Error('Could not parse AlmanacTowers from FrostMenuScreens.cpp');

// Build-menu blurbs: case 10: return TEXT("...");  (named ids: ATowerBase::StoneWallId = 25, StoneDoorId = 26)
const NAMED_IDS = { 'ATowerBase::StoneWallId': 25, 'ATowerBase::StoneDoorId': 26 };
const blurbFn = build.slice(build.indexOf('static FString TowerBlurbRaw(int32 TowerId)\n{'), build.indexOf('FString UFrostBuildMenuBase::TowerName'));
const blurbs = {};
for (const m of blurbFn.matchAll(/case\s+([\w:]+)\s*:\s*return\s+TEXT\("((?:[^"\\]|\\.)*)"\)/g)) {
	const id = NAMED_IDS[m[1]] ?? Number(m[1]);
	blurbs[id] = fmtKeys(m[2].replace(/\\"/g, '"'));
}
// Rime Vent's blurb is printf'd from FrostRime (slow % at level 1 and 8).
{
	const lerp = (name) => rime.match(new RegExp(`${name}\\(int32 Level\\)\\s*\\{\\s*return FMath::Lerp\\(([\\d.]+)f,\\s*([\\d.]+)f`));
	const mv = lerp('MoveSlow'), at = lerp('AttackSlow');
	blurbs[23] = mv && at
		? `A 2-cell wall that breathes dead light: a freezing mist 2 cells out from both faces. Enemies in it move ${Math.round(mv[1] * 100)}-${Math.round(mv[2] * 100)}% and attack ${Math.round(at[1] * 100)}-${Math.round(at[2] * 100)}% slower (by level; bosses half as much). Needs power; R turns it.`
		: 'A 2-cell wall that breathes dead light: a freezing mist that slows the movement and attacks of enemies inside it. Needs power.';
}

// Almanac enemies: { TEXT("Key"), TEXT("Name"), TEXT("Category"), TEXT("Threat"), TEXT("Desc"), TEXT("Ability") }
const enemyLore = [...block(menus, /const FAlmanacEnemy AlmanacEnemies\[\]/).matchAll(/\{\s*(TEXT\(.*?\))\s*\},?\s*$/gm)]
	.map((m) => cTextArgs(m[1]))
	.filter((a) => a.length === 6)
	.map(([key, name, category, threat, desc, ability]) => ({ key, name, category, threat, desc, ability }));
const spots = Object.fromEntries(
	[...block(menus, /const FAlmanacSpot AlmanacSpots\[\]/).matchAll(/\{\s*(TEXT\(.*?\))\s*\},?\s*$/gm)]
		.map((m) => cTextArgs(m[1]))
		.filter((a) => a.length === 3)
		.map(([key, short, spot]) => [key, { short, spot }]),
);
if (!enemyLore.length) throw new Error('Could not parse AlmanacEnemies from FrostMenuScreens.cpp');

// ---------------------------------------------------------------- towers

const CELL = 25; // DataTable range units per grid cell (FrostMenu::PrototypeUnitsPerCell)
const CRYSTALS = [
	['Red', 'red'], ['Purple', 'purple'], ['Green', 'amber'], ['White', 'obsidian'],
];
const cost = (r, prefix) => Object.fromEntries(CRYSTALS.map(([col, key]) => [key, num(r[`${prefix}${col}`])]));
const RES_NAME = { red: 'Red', purple: 'Purple', green: 'Amber', white: 'Obsidian', all: 'All crystals' };

const towers = almanacTowers
	.filter((t) => !HIDDEN_TOWER_IDS.has(t.id))
	.map((t, order) => {
		const levels = towerRows
			.filter((r) => num(r.TowerId) === t.id)
			.sort((a, b) => num(a.Level) - num(b.Level))
			.map((r) => ({
				level: num(r.Level),
				hp: num(r.HP),
				shield: num(r.Shield),
				shieldRecharge: num(r.ShieldRecharge),
				reflect: num(r.Spikes),
				damage: num(r.Damage),
				rangeCells: round(num(r.Range) / CELL),
				shotsPerSecond: round(num(r.FireRate), 2),
				splashCells: round(num(r.SplashRadius) / CELL),
				storedPower: num(r.MaxStoredPower),
				powerUse: num(r.PowerIn),
				powerGen: num(r.PowerGen),
				powerOut: num(r.PowerOut),
				targets: num(r.MaxTargets),
				powerReachCells: round(num(r.PowerRange) / CELL),
				repair: num(r.HealAmount),
				shieldHeal: num(r.ShieldHeal),
				buildCost: cost(r, 'BuildCost'),
				upgradeCost: cost(r, 'UpgradeCost'),
			}));
		if (!levels.length) return null;
		const first = towerRows.find((r) => num(r.TowerId) === t.id);
		const name = FULL_NAMES[first.DisplayName] ?? first.DisplayName;
		return {
			id: t.id,
			order,
			name,
			slug: slugify(name),
			category: t.category,
			primaryCrystal: RES_NAME[first.PrimaryRes] || first.PrimaryRes,
			description: blurbs[t.id] || '',
			upgrades: t.upgrades,
			levels,
		};
	})
	.filter(Boolean);

// ---------------------------------------------------------------- enemies

const enemies = enemyLore
	.map((e, order) => {
		const r = enemyRows.find((x) => x.RowName === e.key);
		if (!r) return null;
		return {
			key: e.key,
			order,
			name: e.name,
			slug: slugify(e.name),
			category: e.category,
			threat: e.threat,
			description: e.desc,
			ability: e.ability,
			howToSpot: spots[e.key]?.spot || '',
			boss: r.IsBoss === 'True',
			baseHp: num(r.Health),
			speed: round(num(r.Speed), 1),
			damage: num(r.Damage),
			drops: num(r.ResourceDrop),
		};
	})
	.filter(Boolean);

// ---------------------------------------------------------------- news (changelog)

const news = [];
for (const sec of changelog.split(/^## /m).slice(1)) {
	const [headLine, ...rest] = sec.split(/\r?\n/);
	const m = headLine.match(/^v?([\d.]+)\s*-\s*(.*?)\s*\((\d{4}-\d{2}-\d{2})\)\s*$/);
	if (!m) continue;
	const items = rest.map((l) => l.match(/^\s*-\s+(.*)$/)?.[1]).filter(Boolean);
	news.push({ version: m[1], title: m[2], date: m[3], slug: `v${m[1].replace(/\./g, '-')}`, items });
}

// ---------------------------------------------------------------- guard + write

const game = { version: VERSION, tag: TAG, releaseDate: tagDate, towers, enemies };
for (const [label, obj] of [['game data', game], ['news', news]]) {
	const s = JSON.stringify(obj);
	if (INTERNAL_NAME.test(s)) {
		const hit = s.match(new RegExp(`.{0,60}${INTERNAL_NAME.source}.{0,60}`, 'i'))[0];
		throw new Error(`Internal project name found in exported ${label}: ...${hit}...  Fix the source text or filter it.`);
	}
}

mkdirSync(join(ROOT, 'src/data'), { recursive: true });
writeFileSync(join(ROOT, 'src/data/game.json'), JSON.stringify(game, null, '\t') + '\n');
writeFileSync(join(ROOT, 'src/data/news.json'), JSON.stringify(news, null, '\t') + '\n');

const GEN_NOTE = `<!-- Generated by scripts/export-game-data.mjs from release ${TAG}. Do not edit by hand. -->`;
const versionAside = `:::note[Game data]\nNumbers on this page come from the released build **v${VERSION}** (${tagDate}).\n:::`;

function costText(c) {
	const parts = [];
	if (c.red) parts.push(`${c.red} Red`);
	if (c.purple) parts.push(`${c.purple} Purple`);
	if (c.amber) parts.push(`${c.amber} Amber`);
	if (c.obsidian) parts.push(`${c.obsidian} Obsidian`);
	return parts.join(', ') || '-';
}

// Only the columns that matter for this tower (a column is shown when any level has a non-zero value).
const TOWER_COLS = [
	['hp', 'HP'], ['shield', 'Shield'], ['shieldRecharge', 'Shield regen /s'], ['reflect', 'Reflect'],
	['damage', 'Damage'], ['rangeCells', 'Range (cells)'], ['shotsPerSecond', 'Shots /s'], ['splashCells', 'Splash (cells)'],
	['powerGen', 'Power /s'], ['powerOut', 'Relay /s'], ['targets', 'Targets'], ['powerReachCells', 'Power reach (cells)'],
	['storedPower', 'Power store'], ['powerUse', 'Power use'], ['repair', 'Repair /s'], ['shieldHeal', 'Shield heal /s'],
];

function towerPage(t) {
	const cols = TOWER_COLS.filter(([k]) => t.levels.some((l) => l[k]));
	const head = `| Level | ${cols.map(([, h]) => h).join(' | ')} | Cost |`;
	const sep = `|---|${cols.map(() => '---:').join('|')}|---|`;
	const rows = t.levels.map((l) => {
		const c = l.level === 1 ? costText(l.buildCost) : costText(l.upgradeCost);
		return `| ${l.level} | ${cols.map(([k]) => l[k]).join(' | ')} | ${c} |`;
	});
	return `---
title: ${yamlStr(t.name)}
description: ${yamlStr(`${t.name}: ${t.category.toLowerCase()} building in Firnreach. Stats for every level.`)}
sidebar:
  order: ${t.order + 1}
---
${GEN_NOTE}

${mdEscape(t.description)}

| | |
|---|---|
| Category | ${t.category} |
| Main crystal | ${t.primaryCrystal} |
| Build cost | ${costText(t.levels[0].buildCost)} |
| Upgrades give | ${mdEscape(t.upgrades)} |

## Levels

The cost on level 1 is the build cost; on later levels it is the cost to upgrade to that level.

${head}
${sep}
${rows.join('\n')}

${versionAside}
`;
}

function enemyPage(e) {
	return `---
title: ${yamlStr(e.name)}
description: ${yamlStr(`${e.name}: ${e.boss ? 'boss' : e.category.toLowerCase() + ' enemy'} in Firnreach.`)}
sidebar:
  order: ${e.order + 1}
${e.boss ? '  badge:\n    text: Boss\n    variant: danger\n' : ''}---
${GEN_NOTE}

> ${mdEscape(e.description)}

| | |
|---|---|
| Type | ${e.category} |
| Threat | ${mdEscape(e.threat)} |
| Base HP | ${e.baseHp} |
| Speed | ${e.speed} |
| Damage | ${e.damage} |
| Crystal drop | ${e.drops} |
${e.ability ? `\n## Ability\n\n${mdEscape(e.ability)}\n` : ''}${e.howToSpot ? `\n## How to spot its attack\n\n${mdEscape(e.howToSpot)}\n` : ''}
${versionAside}
`;
}

const towerIndex = `---
title: Towers
description: Every building you can place in Firnreach, grouped the way the build menu groups them.
sidebar:
  order: 0
  label: All towers
---
${GEN_NOTE}

Towers are built on the grid around your Base. Most of them need **power**: build generators and batteries
in reach, or feed a tower yourself (hold **F** while looking at it). Upgrading the Base raises the level cap for
every other tower.

${['Defense', 'Power', 'Offense', 'Utility']
	.map((cat) => {
		const list = towers.filter((t) => t.category === cat);
		if (!list.length) return '';
		return `## ${cat}\n\n| Tower | Main crystal | Build cost |\n|---|---|---|\n${list
			.map((t) => `| [${t.name}](/wiki/towers/${t.slug}/) | ${t.primaryCrystal} | ${costText(t.levels[0].buildCost)} |`)
			.join('\n')}\n`;
	})
	.join('\n')}
${versionAside}
`;

const enemyIndex = `---
title: Enemies
description: The things that come out of the cold at night, with base stats and how to read their attacks.
sidebar:
  order: 0
  label: All enemies
---
${GEN_NOTE}

Enemies come at night, in waves, and head for your Base. Stats below are **base values**: difficulty and wave
number scale them up.

| Enemy | Type | Threat | Base HP | Speed |
|---|---|---|---:|---:|
${enemies.map((e) => `| [${e.name}](/wiki/enemies/${e.slug}/) | ${e.category} | ${mdEscape(e.threat)} | ${e.baseHp} | ${e.speed} |`).join('\n')}

${versionAside}
`;

for (const [dir, list, page, index] of [
	['towers', towers, towerPage, towerIndex],
	['enemies', enemies, enemyPage, enemyIndex],
]) {
	const out = join(ROOT, 'src/content/docs/wiki', dir);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, 'index.md'), index);
	for (const item of list) writeFileSync(join(out, `${item.slug}.md`), page(item));
}

console.log(`Exported from ${TAG} (${tagDate}): ${towers.length} towers, ${enemies.length} enemies, ${news.length} news posts.`);
