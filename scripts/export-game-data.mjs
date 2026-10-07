#!/usr/bin/env node
/**
 * export-game-data.mjs - pull RELEASED, player-facing game data from the game repo into this site.
 *
 * Reads everything from a release tag (default: the newest vX.Y.Z tag) with `git show <tag>:<path>`,
 * so unreleased balance changes and work-in-progress content in the game repo can never leak onto the site.
 *
 * What it mirrors is what players see in game: the Almanac (PLAYER / BUILDINGS / ENEMIES / RELICS tabs), the build
 * menu blurbs, the achievements screen, the trainer's skill tree, the Hollow's shops and stations, the pick, the match
 * setup screen (difficulty presets, match length, world options), the default key bindings and the in-match hints.
 *
 * Sources (all at the tag; paths under Frostborn-Unreal/Source/<module>/):
 *   Balance/DT_Towers_live.csv, Balance/DT_Enemies_live.csv  - the DataTable exports (numbers)
 *   UI/FrostMenuScreens.cpp      - Almanac lists (towers, enemies, "how to spot its attack", PLAYER tab, relic books)
 *   UI/FrostBuildMenuBase.cpp    - one-line tower descriptions (build menu)
 *   Towers/FrostRimeVent.h       - Rime Vent slow numbers
 *   Save/FrostAchievements.cpp   - achievements (name, how to unlock, bonus)
 *   Save/FrostRelics.cpp         - relics (name, lore, hint, Hollow reward)
 *   Save/FrostSkills.cpp         - the skill tree (branches, nodes, costs, unlock levels)
 *   Core/FrostEconomy.cpp/.h     - Hollow shop items, pick tiers and prices
 *   Core/FrostKeyBindings.cpp    - default key bindings
 *   Core/FrostHints.cpp          - the first-time hints shown in a match
 *   Data/FrostMatchSettings.cpp  - difficulty presets, match lengths, upgrade-cost rules, world options
 *   Menu/FrostHubScene.cpp       - Hollow station names and prompts, shop signs
 *   Player/FrostSpecialty.h      - which crystal builds what, mining specialty
 *   CHANGELOG.md                 - news / patch notes
 *
 * Writes (all generated - do not edit by hand):
 *   src/data/game.json, src/data/news.json
 *   src/content/docs/wiki/towers/*.mdx, enemies/*.mdx, skills/*.mdx, hollow/*.mdx
 *   src/content/docs/wiki/{player,relics,achievements,resources,picks,match-settings,controls}.mdx
 *
 * Usage:
 *   node scripts/export-game-data.mjs [--repo "E:/Game Making/<game repo>"] [--tag v0.0.21]
 *   (env GAME_REPO works too). Generated files are committed, so the site builds without the game repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
// The game repo's folder is named after the internal project; build the default path without spelling it out here.
const REPO = resolve(argVal('--repo') || process.env.GAME_REPO || join(ROOT, '..', ['Frost', 'born'].join('')));
const MODULE = ['Frost', 'born'].join('');
const SRC = `${MODULE}-Unreal/Source/${MODULE}`;

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
const showSrc = (rel) => show(`${SRC}/${rel}`);
const tryShowSrc = (rel) => {
	try { return showSrc(rel); } catch { console.warn(`  (missing at ${TAG}: ${rel})`); return ''; }
};
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
const fullNames = (s) => Object.entries(FULL_NAMES).reduce((t, [a, b]) => t.split(a).join(b), s);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const unescapeC = (s) => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
const TEXT_RE = /TEXT\("((?:[^"\\]|\\.)*)"\)/g;
const cTextArgs = (s) => [...s.matchAll(TEXT_RE)].map((m) => unescapeC(m[1]));
// Markdown-in-MDX text: escape what MDX would treat as JSX / expressions, and table pipes.
const mdx = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/\|/g, '\\|');
const mdxLines = (s) => mdx(s).split('\n').join('  \n');
const yamlStr = (s) => JSON.stringify(String(s));
const attr = (s) => JSON.stringify(String(s)); // JSX string attribute
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

function block(text, startRe) {
	const start = text.search(startRe);
	if (start < 0) return '';
	const end = text.indexOf('};', start);
	return text.slice(start, end);
}

// ---------------------------------------------------------------- read sources at the tag

const menus = showSrc('UI/FrostMenuScreens.cpp');
const build = showSrc('UI/FrostBuildMenuBase.cpp');
const towerRows = parseCsv(show('Balance/DT_Towers_live.csv'));
const enemyRows = parseCsv(show('Balance/DT_Enemies_live.csv'));
const changelog = show('CHANGELOG.md');
const rime = tryShowSrc('Towers/FrostRimeVent.h');
const keysSrc = tryShowSrc('Core/FrostKeyBindings.cpp');
const achSrc = tryShowSrc('Save/FrostAchievements.cpp');
const relicSrc = tryShowSrc('Save/FrostRelics.cpp');
const skillSrc = tryShowSrc('Save/FrostSkills.cpp');
const skillHdr = tryShowSrc('Save/FrostSkills.h');
const econSrc = tryShowSrc('Core/FrostEconomy.cpp');
const econHdr = tryShowSrc('Core/FrostEconomy.h');
const hintSrc = tryShowSrc('Core/FrostHints.cpp');
const matchSrc = tryShowSrc('Data/FrostMatchSettings.cpp');
const hubScene = tryShowSrc('Menu/FrostHubScene.cpp');
const hubMode = tryShowSrc('Menu/FrostHubGameMode.cpp');
const specSrc = tryShowSrc('Player/FrostSpecialty.h');

// ---------------------------------------------------------------- key bindings (defaults)

const KEY_LABELS = {
	LeftMouseButton: 'Left Mouse', RightMouseButton: 'Right Mouse', MiddleMouseButton: 'Middle Mouse',
	ThumbMouseButton: 'Mouse 4', ThumbMouseButton2: 'Mouse 5', SpaceBar: 'Space', LeftShift: 'Shift', RightShift: 'Right Shift',
	LeftControl: 'Ctrl', RightControl: 'Right Ctrl', LeftAlt: 'Alt', RightAlt: 'Right Alt', BackSpace: 'Backspace',
	Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Home: 'Home', End: 'End',
	One: '1', Two: '2', Three: '3', Four: '4', Five: '5', Six: '6', Seven: '7', Eight: '8', Nine: '9', Zero: '0',
};
const keySections = Object.fromEntries([...keysSrc.matchAll(/const TCHAR\* (\w) = TEXT\("([^"]*)"\);/g)].map((m) => [m[1], m[2]]));
const keybinds = [...keysSrc.matchAll(/Add\(TEXT\("(\w+)"\),\s*TEXT\("((?:[^"\\]|\\.)*)"\),\s*(\w),\s*EKeys::(\w+)/g)].map((m) => ({
	id: m[1],
	action: unescapeC(m[2]),
	section: keySections[m[3]] || m[3],
	key: KEY_LABELS[m[4]] ?? m[4],
}));
const KEYS = Object.fromEntries(keybinds.map((k) => [k.id, k.key]));
if (!keybinds.length) {
	// Fallback (older tags): the defaults as of v0.0.20.
	Object.assign(KEYS, {
		TakeGun: 'Q', ShieldToggle: 'T', Aim: 'Right Mouse', FeedPower: 'F', AutoPower: 'V', Interact: 'E', Build: 'B',
		ToggleView: 'Tab', Upgrade: 'U', Sell: 'X', Rotate: 'R', Mine: 'Left Mouse', Jump: 'Space', Sprint: 'Shift', Ping: 'G',
		Surge: 'K', SkipDay: 'J', BaseMenu: 'Home', Chat: 'Enter', Pause: 'P',
		MoveForward: 'W', MoveLeft: 'A', MoveBack: 'S', MoveRight: 'D', PanUp: 'W', PanLeft: 'A', PanDown: 'S', PanRight: 'D',
		Select: 'Left Mouse', Order: 'Right Mouse', ClearOrders: 'Backspace', MineGuide: 'M',
	});
}
const fmtKeys = (s) => s.replace(/\{(\w+)\}/g, (all, k) => {
	if (k === 'Move') return [KEYS.MoveForward, KEYS.MoveLeft, KEYS.MoveBack, KEYS.MoveRight].join('');
	if (k === 'Pan') return [KEYS.PanUp, KEYS.PanLeft, KEYS.PanDown, KEYS.PanRight].join('');
	if (k === 'Slots') return '1-5';
	if (k === 'GameTitle') return 'Firnreach';
	return KEYS[k] || all;
});

// ---------------------------------------------------------------- Almanac: buildings

const almanacTowers = [...block(menus, /const FAlmanacTower AlmanacTowers\[\]/).matchAll(/\{\s*(\d+)\s*,\s*TEXT\("([^"]*)"\)\s*,\s*TEXT\("([^"]*)"\)\s*\}/g)]
	.map((m) => ({ id: Number(m[1]), category: m[2], upgrades: m[3] }));
if (!almanacTowers.length) throw new Error('Could not parse AlmanacTowers from FrostMenuScreens.cpp');

// Build-menu blurbs: case 10: return TEXT("...");  (named ids: ATowerBase::StoneWallId = 25, StoneDoorId = 26)
const NAMED_IDS = { 'ATowerBase::StoneWallId': 25, 'ATowerBase::StoneDoorId': 26 };
const blurbFn = build.slice(build.indexOf('static FString TowerBlurbRaw(int32 TowerId)\n{'), build.indexOf('FString UFrostBuildMenuBase::TowerName'));
const blurbs = {};
for (const m of blurbFn.matchAll(/case\s+([\w:]+)\s*:\s*return\s+TEXT\("((?:[^"\\]|\\.)*)"\)/g)) {
	const id = NAMED_IDS[m[1]] ?? Number(m[1]);
	blurbs[id] = fullNames(fmtKeys(unescapeC(m[2])));
}
// Rime Vent's blurb is printf'd from FrostRime (slow % at level 1 and 8, plus an unlock line when gated).
{
	const lerp = (name) => rime.match(new RegExp(`${name}\\(int32 Level\\)\\s*\\{\\s*return FMath::Lerp\\(([\\d.]+)f,\\s*([\\d.]+)f`));
	const mv = lerp('MoveSlow'), at = lerp('AttackSlow');
	const unlockWave = Number(rime.match(/UnlockWave\s*=\s*(\d+)/)?.[1] || 0);
	const lockedReason = rime.match(/LockedReason\(\)\s*\{\s*return TEXT\("([^"]*)"\)/)?.[1];
	blurbs[23] = (mv && at
		? `A 2-cell wall that breathes dead light: a freezing mist 2 cells out from both faces. Enemies in it move ${Math.round(mv[1] * 100)}-${Math.round(mv[2] * 100)}% and attack ${Math.round(at[1] * 100)}-${Math.round(at[2] * 100)}% slower (by level; bosses half as much). Needs power; ${KEYS.Rotate || 'R'} turns it.`
		: 'A 2-cell wall that breathes dead light: a freezing mist that slows the movement and attacks of enemies inside it. Needs power.')
		+ (unlockWave > 0 && lockedReason ? ` ${lockedReason}.` : '');
}

// ---------------------------------------------------------------- Almanac: enemies

// { TEXT("Key"), TEXT("Name"), TEXT("Category"), TEXT("Threat"), TEXT("Desc"), TEXT("Ability") }
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

// ---------------------------------------------------------------- Almanac: PLAYER tab

// Card titles (size 15) followed by their body text, in order.
const playerTab = (() => {
	const start = menus.indexOf('else if (Page == TEXT("PLAYER"))');
	const end = menus.indexOf('else if (Page == TEXT("BUILDINGS"))', start);
	if (start < 0 || end < 0) return [];
	const body = menus.slice(start, end);
	const texts = [...body.matchAll(/AddText\((?:\*?FrostKeys::Fmt\()?TEXT\("((?:[^"\\]|\\.)*)"\)\)?\)?,\s*(\d+)/g)].map((m) => ({ text: unescapeC(m[1]), size: Number(m[2]) }));
	const cards = [];
	for (const t of texts) {
		if (t.size >= 15) cards.push({ title: t.text, body: '' });
		else if (cards.length) cards[cards.length - 1].body += (cards[cards.length - 1].body ? '\n' : '') + fmtKeys(t.text);
	}
	return cards;
})();

// ---------------------------------------------------------------- Almanac: RELICS tab

const relicIntro = unescapeC(menus.match(/RELICS RECOVERED[\s\S]*?AddText\(TEXT\("((?:[^"\\]|\\.)*)"\)/)?.[1] || '');
const relicBooks = Object.fromEntries(
	[...menus.matchAll(/D\.Id == FrostRelics::(\w+)\)\s*\{\s*BookTitle = TEXT\("((?:[^"\\]|\\.)*)"\);\s*BookText = TEXT\("((?:[^"\\]|\\.)*)"\);/g)]
		.map((m) => [m[1], { title: unescapeC(m[2]), text: unescapeC(m[3]) }]),
);
const relics = [...relicSrc.matchAll(/\{\s*(\w+),\s*((?:TEXT\("(?:[^"\\]|\\.)*"\)\s*,?\s*){4})\}/g)].map((m) => {
	const [name, lore, hint, reward] = cTextArgs(m[2]);
	return { id: m[1], name, lore, hint, reward, book: relicBooks[m[1]] || null };
});

// ---------------------------------------------------------------- achievements

const achievements = [...achSrc.matchAll(/Def\(((?:TEXT\("(?:[^"\\]|\\.)*"\)\s*,\s*){4}TEXT\("(?:[^"\\]|\\.)*"\))\s*(,\s*false)?\s*\)/g)].map((m) => {
	const [category, id, name, objective, bonus] = cTextArgs(m[1]);
	return { category, id, name, objective, bonus, tracked: !m[2] };
});

// ---------------------------------------------------------------- skill tree

const skillConst = (name, fallback) => Number(skillHdr.match(new RegExp(`${name}\\s*=\\s*(\\d+)`))?.[1] ?? fallback);
const ADV_LEVEL = skillConst('AdvancedUnlockLevel', 100);
const BASE_MAX_LEVEL = skillConst('BaseMaxLevel', 100);
const PRESTIGE_STEP = skillConst('PrestigeLevelStep', 5);
const MAX_PRESTIGE = skillConst('MaxPrestige', 20);
const skillDefs = [...skillSrc.matchAll(/\{\s*TEXT\("(\w+)"\),\s*TEXT\("(\w+)"\),\s*TEXT\("((?:[^"\\]|\\.)*)"\),\s*TEXT\("((?:[^"\\]|\\.)*)"\),\s*\{([\d,\s]+)\},\s*TEXT\("(\w*)"\),\s*(\d+),\s*TEXT\("\w*"\),\s*TEXT\("\w*"\),\s*\d+,\s*(\d+)\s*\}/g)]
	.map((m) => ({
		id: m[1], branch: m[2], name: m[3], summary: unescapeC(m[4]),
		costs: m[5].split(',').map((x) => Number(x.trim())).filter((x) => x > 0),
		requires: m[6], requiresRank: Number(m[7]), minLevel: Number(m[8]),
	}));
const branchOrder = (skillSrc.match(/Branches\(\)[\s\S]*?\{([\s\S]*?)\};/)?.[1].match(/TEXT\("(\w+)"\)/g) || []).map((t) => t.slice(6, -2));
const branchLevelExplicit = Object.fromEntries([...skillSrc.matchAll(/if \(Branch == TEXT\("(\w+)"\)\)\s*return (\d+);/g)].map((m) => [m[1], Number(m[2])]));
const advancedSet = new Set([...(skillSrc.match(/bool IsAdvancedBranch[\s\S]*?\n\t\}/)?.[0].matchAll(/TEXT\("(\w+)"\)/g) || [])].map((m) => m[1]));
const branchLevel = (b) => branchLevelExplicit[b] ?? (advancedSet.has(b) ? ADV_LEVEL : 1);
// Show the basic branches in the order the trainer opens them, then the master classes.
const BASIC_FIRST = ['GENERALIST', 'MINER', 'FIGHTER', 'POWER', 'ENGINEER'];
const skillBranches = [...new Set([...BASIC_FIRST.filter((b) => branchOrder.includes(b)), ...branchOrder])]
	.filter((b) => skillDefs.some((d) => d.branch === b))
	.map((b) => {
		const nodes = skillDefs.filter((d) => d.branch === b).map((d) => ({
			...d,
			unlockLevel: Math.max(branchLevel(b), d.minLevel),
			requiresName: skillDefs.find((x) => x.id === d.requires)?.name || '',
		}));
		const nameNode = nodes.find((n) => n.id === `name_${b.toLowerCase()}`);
		return {
			key: b,
			name: titleCase(b),
			slug: slugify(b),
			advanced: advancedSet.has(b),
			unlockLevel: branchLevel(b),
			// Master classes: the name node's own line ("The Miner's master class."). Basic branches: the table's tagline.
			summary: advancedSet.has(b)
				? nameNode?.summary.replace(/^Start every match with \+5 of each resource\.\s*/, '') || ''
				: (skillSrc.match(new RegExp(`// ${b}(?: \\([^)]*\\))?: ([^.]*\\.)`))?.[1] || '').replace(/^./, (c) => c.toUpperCase()),
			nodes: nodes.sort((a, z) => (a.id === nameNode?.id ? -1 : z.id === nameNode?.id ? 1 : a.unlockLevel - z.unlockLevel)),
		};
	});

// ---------------------------------------------------------------- Hollow: shops, stations, pick

const arrOf = (src, name) => (src.match(new RegExp(`${name}\\[[^\\]]*\\]\\s*=\\s*\\{([^}]*)\\}`))?.[1] || '').split(',').map((x) => Number(x.trim().replace(/f$/, ''))).filter((x) => !Number.isNaN(x));
const econConst = (name) => Number(econHdr.match(new RegExp(`${name}\\s*=\\s*([\\d.]+)`))?.[1] ?? NaN);
const TIP_ESS = arrOf(econHdr, 'TipPriceEssence');
const TIP_HS = arrOf(econHdr, 'TipPriceHeartstone');
const TIP_SPEED = arrOf(econHdr, 'TipSpeedBonus');
const PICK_TIERS = (econSrc.match(/Names\[PickTierCount \+ 1\]\s*=\s*\{([^}]*)\}/)?.[1].match(/TEXT\("([^"]*)"\)/g) || []).map((t) => t.slice(6, -2)).slice(1);
const resolvePrice = (expr) => {
	const e = expr.trim();
	if (/^\d+$/.test(e)) return Number(e);
	const arr = e.match(/^(\w+)\[(\d+)\]$/);
	if (arr) return arrOf(econHdr, arr[1])[Number(arr[2])] ?? null;
	const c = econConst(e);
	return Number.isNaN(c) ? null : c;
};
const shopItems = [...(block(econSrc, /const TArray<FShopItem>& ShopItems\(\)/).matchAll(/\{\s*TEXT\("(\w+)"\),\s*TEXT\("(\w+)"\),\s*TEXT\("((?:[^"\\]|\\.)*)"\),\s*TEXT\("((?:[^"\\]|\\.)*)"\),\s*([\w[\]]+),\s*([\w[\]]+),\s*([\w\s-]+?),?\s*(?:EShopKind::(\w+))?\s*\}/g))]
	.map((m) => ({
		id: m[1], shop: m[2], name: unescapeC(m[3]), effect: unescapeC(m[4]),
		essence: resolvePrice(m[5]), heartstone: resolvePrice(m[6]),
		max: /PickTierCount\s*-\s*1/.test(m[7]) ? PICK_TIERS.length - 1 : Number(m[7]),
		kind: m[8] || 'Upgrade',
	}));
const shopSign = (() => {
	const arr = (name) => (hubScene.match(new RegExp(`const (?:TCHAR\\*|FName) ${name}\\[\\]\\s*=\\s*\\{([^}]*)\\}`))?.[1].match(/TEXT\("([^"]*)"\)/g) || []).map((t) => t.slice(6, -2));
	const ids = arr('Ids'), titles = arr('Titles'), subs = arr('Subs'), prompts = arr('Prompts');
	return ids.map((id, i) => ({ id, title: titles[i] || id, sub: (subs[i] || '').replace(/^-\s*|\s*-$/g, ''), prompt: prompts[i] || '' }));
})();
const stations = (() => {
	const seen = new Map();
	for (const m of hubScene.matchAll(/AddStation\(TEXT\("(\w+)"\),\s*TEXT\("([^"]*)"\),\s*TEXT\("([^"]*)"\)/g)) if (!seen.has(m[1])) seen.set(m[1], { id: m[1], title: m[2], prompt: m[3] });
	return [...seen.values()];
})();
const handleStandard = hubMode.match(/AddShopCard\(TEXT\("pick_handle_standard"\),\s*TEXT\("([^"]*)"\),\s*TEXT\("([^"]*)"\)/);
const shopFooter = fmtKeys(unescapeC(hubMode.match(/Footer = FrostKeys::Fmt\(TEXT\("((?:[^"\\]|\\.)*)"\)\)/)?.[1] || ''));
const pickFocuses = [...econSrc.matchAll(/case EPickFocus::(\w+):\s*return TEXT\("([^"]*)"\);/g)].map((m) => m[2]);

// ---------------------------------------------------------------- match settings

const tArr = (fn) => (matchSrc.match(new RegExp(`FFrostMatchSettings::${fn}\\(\\)[\\s\\S]*?\\{([\\s\\S]*?)\\};`))?.[1] || '').match(TEXT_RE)?.map((t) => unescapeC(t.slice(6, -2))) || [];
const numArr = (name) => (matchSrc.match(new RegExp(`${name}\\[\\]\\s*=\\s*\\{([^}]*)\\}`))?.[1] || '').split(',').map((x) => Number(x.trim().replace(/f$/, ''))).filter((x) => !Number.isNaN(x));
const matchSettings = {
	presets: tArr('PresetNames').map((name, i) => ({ name, description: tArr('PresetDescriptions')[i] || '' })),
	lengths: tArr('LengthNames').map((name, i) => ({ name, description: tArr('LengthDescriptions')[i] || '', waves: numArr('LengthWaves')[i] ?? null })),
	upgradeCost: tArr('UpgradeReqNames').map((name, i) => ({ name, description: tArr('UpgradeReqDescriptions')[i] || '' })),
	prepSeconds: numArr('PrepVals'),
	safeZone: numArr('SafeZoneVals'),
	coverage: numArr('CoverageVals'),
	crystals: numArr('ResourceVals'),
};
// The match setup screen's own lines (specialty, secrets, deep lift).
const setupText = (needle) => unescapeC(menus.match(new RegExp(`TEXT\\("(${needle}(?:[^"\\\\]|\\\\.)*)"\\)`))?.[1] || '');

// ---------------------------------------------------------------- crystals + hints

const buildsLine = Object.fromEntries([...(specSrc.match(/BuildsLine\(E_CrystalColor C\)[\s\S]*?\n\t\}/)?.[0] || '').matchAll(/case E_CrystalColor::(\w+): return TEXT\("([^"]*)"\);/g)].map((m) => [m[1], m[2]]));
const hints = [...hintSrc.matchAll(/if \(Id == (\w+)\)\s*\{\s*return TEXT\("((?:[^"\\]|\\.)*)"\);/g)].map((m) => ({ id: m[1], text: fmtKeys(unescapeC(m[2])) }));

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
			short: spots[e.key]?.short || e.name,
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

// ---------------------------------------------------------------- guard + write data

// Achievement bonuses still being designed in game read like notes ("...?"); the wiki leaves those out.
const bonusShown = (b) => (/\?\s*$/.test(b.trim()) ? '' : b.trim().replace(/^[a-z]/, (c) => c.toUpperCase()).replace(/([^.!])$/, '$1.'));

const game = {
	version: VERSION, tag: TAG, releaseDate: tagDate,
	towers, enemies,
	playerTab, relics, relicIntro, achievements, skillBranches,
	shops: shopSign.map((s) => ({ ...s, items: shopItems.filter((i) => i.shop === s.id) })),
	stations, pickTiers: PICK_TIERS, matchSettings, hints, keybinds,
};
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

// ---------------------------------------------------------------- page building blocks

const WIKI = join(ROOT, 'src/content/docs/wiki');
const GEN_NOTE = `{/* Generated by scripts/export-game-data.mjs from release ${TAG}. Do not edit by hand. */}`;
const versionAside = `:::note[Game data]\nFrom the released build **v${VERSION}** (${tagDate}).\n:::`;
const imp = (depth) => `import AlmanacCard from '${'../'.repeat(depth)}components/AlmanacCard.astro';`;

function frontmatter({ title, description, order, label, badge }) {
	let s = `---\ntitle: ${yamlStr(title)}\ndescription: ${yamlStr(description)}\n`;
	if (order != null || label || badge) {
		s += 'sidebar:\n';
		if (order != null) s += `  order: ${order}\n`;
		if (label) s += `  label: ${yamlStr(label)}\n`;
		if (badge) s += `  badge:\n    text: ${yamlStr(badge.text)}\n    variant: ${badge.variant}\n`;
	}
	return s + '---\n';
}

function card({ section, slug, name, kicker, threat, tone, image = true }) {
	const props = [`name=${attr(name)}`, `kicker=${attr(kicker)}`];
	if (section) props.push(`section=${attr(section)}`, `slug=${attr(slug)}`);
	if (threat) props.push(`threat=${attr(threat)}`);
	if (tone) props.push(`tone=${attr(tone)}`);
	if (!image) props.push('noImage');
	return `<AlmanacCard ${props.join(' ')} />`;
}

function costText(c) {
	const parts = [];
	if (c.red) parts.push(`${c.red} Red`);
	if (c.purple) parts.push(`${c.purple} Purple`);
	if (c.amber) parts.push(`${c.amber} Amber`);
	if (c.obsidian) parts.push(`${c.obsidian} Obsidian`);
	return parts.join(', ') || '-';
}

// Text tables (everything but the per-level stat tables) go in a wrapper whose cells may wrap (starlight.css .wrap-table).
const wrapTables = (body) => body.replace(/(?:^\|.*\|[ \t]*\r?\n)+/gm, (t) => (/^\| Level \|/.test(t) ? t : `<div class="wrap-table">\n\n${t}\n</div>\n`));

// Pages in a generated folder: wipe the folder (both .md and .mdx from older exports), then write.
function writeFolder(dir, pages) {
	const out = join(WIKI, dir);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	for (const [file, body] of pages) writeFileSync(join(out, file), wrapTables(body));
}
function writeRoot(file, body) {
	for (const ext of ['.md', '.mdx']) {
		const p = join(WIKI, file.replace(/\.mdx$/, ext));
		if (existsSync(p)) rmSync(p);
	}
	writeFileSync(join(WIKI, file), wrapTables(body));
}

// ---------------------------------------------------------------- towers (BUILDINGS tab)

// Only the columns that matter for this tower (a column is shown when any level has a non-zero value).
const TOWER_COLS = [
	['hp', 'HP'], ['shield', 'Shield'], ['shieldRecharge', 'Shield regen /s'], ['reflect', 'Reflect'],
	['damage', 'Damage'], ['rangeCells', 'Range (cells)'], ['shotsPerSecond', 'Shots /s'], ['splashCells', 'Splash (cells)'],
	['powerGen', 'Power /s'], ['powerOut', 'Relay /s'], ['targets', 'Targets'], ['powerReachCells', 'Power reach (cells)'],
	['storedPower', 'Power store'], ['powerUse', 'Power use'], ['repair', 'Repair /s'], ['shieldHeal', 'Shield heal /s'],
];
const CAT_LINE = {
	Defense: 'Walls and doors: they block the lanes and take the hits.',
	Power: 'Make, store and pass on the power most towers run on.',
	Offense: 'The guns. Each one has a weapon you can take off its stand.',
	Utility: 'Repairs, shields, the Siphon and the Base itself.',
};

function towerPage(t) {
	const cols = TOWER_COLS.filter(([k]) => t.levels.some((l) => l[k]));
	const head = `| Level | ${cols.map(([, h]) => h).join(' | ')} | Cost |`;
	const sep = `|---|${cols.map(() => '---:').join('|')}|---|`;
	const rows = t.levels.map((l) => {
		const c = l.level === 1 ? costText(l.buildCost) : costText(l.upgradeCost);
		return `| ${l.level} | ${cols.map(([k]) => l[k]).join(' | ')} | ${c} |`;
	});
	const crystalLine = buildsLine[{ Red: 'Red', Purple: 'Purple', Amber: 'Green', Obsidian: 'White' }[t.primaryCrystal]];
	return `${frontmatter({ title: t.name, description: `${t.name}: ${t.category.toLowerCase()} building in Firnreach. What it does and its stats at every level.`, order: t.order + 1 })}
${imp(4)}

${GEN_NOTE}

${card({ section: 'towers', slug: t.slug, name: t.name, kicker: `Building · ${t.category}`, tone: t.category.toLowerCase() })}

${mdx(t.description)}

| | |
|---|---|
| Category | ${t.category} |
| Main crystal | ${t.primaryCrystal}${crystalLine ? ` (${mdx(crystalLine.replace(/^\w+: /, ''))})` : ''} |
| Build cost | ${costText(t.levels[0].buildCost)} |
| Upgrades give | ${mdx(t.upgrades)} |

## Levels

The cost on level 1 is the build cost; on later levels it is the cost to upgrade to that level. Your Base's level caps
how far every other building can be upgraded.

${head}
${sep}
${rows.join('\n')}

${versionAside}
`;
}

const towerIndex = `${frontmatter({ title: 'Buildings', description: 'Every building you can place in Firnreach, grouped the way the build menu groups them.', order: 0, label: 'All buildings' })}
${imp(4)}

${GEN_NOTE}

${card({ name: 'Buildings', kicker: 'Almanac', image: false })}

Buildings go on the grid around your Base, and the Base comes first: until it is placed, the build cards say
**BUILD YOUR BASE FIRST**. Most buildings need **power**: build generators and batteries in reach, or feed a
tower yourself (hold **${KEYS.FeedPower}** while looking at it). Upgrading the Base raises the level cap for every other building.

${['Defense', 'Power', 'Offense', 'Utility']
	.map((cat) => {
		const list = towers.filter((t) => t.category === cat);
		if (!list.length) return '';
		return `## ${cat}\n\n${CAT_LINE[cat] || ''}\n\n| Building | Main crystal | Build cost | Upgrades give |\n|---|---|---|---|\n${list
			.map((t) => `| [${t.name}](/wiki/towers/${t.slug}/) | ${t.primaryCrystal} | ${costText(t.levels[0].buildCost)} | ${mdx(t.upgrades)} |`)
			.join('\n')}\n`;
	})
	.join('\n')}
${versionAside}
`;

writeFolder('towers', [['index.mdx', towerIndex], ...towers.map((t) => [`${t.slug}.mdx`, towerPage(t)])]);

// ---------------------------------------------------------------- enemies (ENEMIES tab)

function enemyPage(e) {
	return `${frontmatter({
		title: e.name,
		description: `${e.name}: ${e.boss ? 'boss' : e.category.toLowerCase() + ' enemy'} in Firnreach. How to spot its attack, its ability and base stats.`,
		order: e.order + 1,
		badge: e.boss ? { text: 'Boss', variant: 'danger' } : undefined,
	})}
${imp(4)}

${GEN_NOTE}

${card({ section: 'enemies', slug: e.slug, name: e.name, kicker: e.category, threat: e.threat, tone: e.boss ? 'boss' : 'enemy' })}

${e.howToSpot ? `## How to spot its attack\n\n${mdx(e.howToSpot)}\n\n` : ''}> ${mdx(e.description)}
${e.ability ? `\n## Ability\n\n${mdx(e.ability)}\n` : ''}
## Base stats

| | |
|---|---|
| Type | ${e.category} |
| Threat | ${mdx(e.threat)} |
| Base HP | ${e.baseHp} |
| Speed | ${e.speed} |
| Damage | ${e.damage} |
| Crystal drop | ${e.drops} |

Base values: difficulty and the wave number scale them up.

${versionAside}
`;
}

const ENEMY_GROUPS = [
	['Regular', 'The bulk of every wave.'],
	['Unique', 'Rarer enemies that change how a wave plays.'],
	['Boss', 'A boss walks every few waves (every 5th in a Standard match). Aim your own shots at its glowing weak spots: they hit for double.'],
];
const enemyIndex = `${frontmatter({ title: 'Enemies', description: 'The things that come out of the cold at night: every enemy and boss, its threat, and how to read its attacks.', order: 0, label: 'All enemies' })}
${imp(4)}

${GEN_NOTE}

${card({ name: 'Enemies', kicker: 'Almanac', image: false })}

Enemies come at night, in waves, through the lanes at the edge of the map. They go for your Base, and for you.
Each page says how to spot the enemy's attack before it lands. Stats are **base values**: difficulty and the wave
number scale them up.

${ENEMY_GROUPS.map(([cat, line]) => {
	const list = enemies.filter((e) => e.category === cat);
	if (!list.length) return '';
	return `## ${cat === 'Boss' ? 'Bosses' : cat}\n\n${line}\n\n| Enemy | Threat | Ability | Base HP | Speed |\n|---|---|---|---:|---:|\n${list
		.map((e) => `| [${e.name}](/wiki/enemies/${e.slug}/) | ${mdx(e.threat)} | ${mdx((e.ability.split(':')[0] || '-').trim() || '-')} | ${e.baseHp} | ${e.speed} |`)
		.join('\n')}\n`;
}).join('\n')}
${versionAside}
`;

writeFolder('enemies', [['index.mdx', enemyIndex], ...enemies.map((e) => [`${e.slug}.mdx`, enemyPage(e)])]);

// ---------------------------------------------------------------- PLAYER tab

writeRoot('player.mdx', `${frontmatter({ title: 'The player', description: 'The Almanac PLAYER tab: the two views, first person, the commander view and how a match is survived.', order: 1, label: 'Player' })}
${imp(3)}

${GEN_NOTE}

${card({ name: 'Player', kicker: 'Almanac', image: false })}

What the Almanac's **PLAYER** tab tells you, with the default keys filled in. Every key can be rebound in
Settings; see [Controls](/wiki/controls/) for the full list.

${playerTab.map((c) => `## ${titleCase(c.title).replace(/\bRts\b/, 'RTS')}\n\n${c.body.split('\n').map((l) => `- ${mdx(l)}`).join('\n')}\n`).join('\n')}
${versionAside}
`);

// ---------------------------------------------------------------- RELICS tab

writeRoot('relics.mdx', `${frontmatter({ title: 'Relics', description: 'The relics hidden out on the ice: where to look, and what each one restores in the Hollow.', order: 4, label: 'Relics' })}
${imp(3)}

${GEN_NOTE}

${card({ name: 'Relics', kicker: 'Almanac', image: false })}

${mdx(relicIntro)}

In game, a relic you haven't found shows as **? ? ?** with only its hint. The hints are below; open a spoiler
to read the rest. Relics only turn up when the host leaves **Secrets on the ice** on (it is on by default).

${relics.map((r, i) => `## Relic ${i + 1}

**Hint:** ${mdx(r.hint)}

<details>
<summary>Spoiler: what it is</summary>

**${mdx(r.name)}**

${mdx(r.lore)}

**In the Hollow:** ${mdx(r.reward)}
${r.book ? `\n**In the library:** *${mdx(r.book.title)}*. ${mdx(r.book.text)}\n` : ''}
</details>
`).join('\n')}
${versionAside}
`);

// ---------------------------------------------------------------- achievements

const achCats = [...new Set(achievements.map((a) => a.category))];
writeRoot('achievements.mdx', `${frontmatter({ title: 'Achievements', description: `All ${achievements.length} Firnreach achievements: how to unlock each one and the permanent bonus it gives.`, order: 3, label: 'Achievements' })}
${imp(3)}

${GEN_NOTE}

${card({ name: 'Achievements', kicker: 'Records', image: false })}

Achievements are kept per profile and most give a small **permanent bonus**. Check your progress at the
**Records** station in the Hollow; lifetime totals count across every match you play.

${achCats.map((cat) => `## ${cat}

| Achievement | How to unlock | Bonus |
|---|---|---|
${achievements.filter((a) => a.category === cat).map((a) => `| **${mdx(a.name)}** | ${mdx(fullNames(a.objective))}${a.tracked ? '' : ' *(not obtainable yet)*'} | ${mdx(fullNames(bonusShown(a.bonus))) || '-'} |`).join('\n')}
`).join('\n')}
${versionAside}
`);

// ---------------------------------------------------------------- skill tree

const ptsText = (costs) => (costs.every((c) => c === costs[0]) ? `${costs[0]}` : costs.join(' / '));
function branchPage(b, i) {
	const kicker = b.advanced ? `Master class · opens at level ${b.unlockLevel}` : `Branch · opens at level ${b.unlockLevel}`;
	return `${frontmatter({ title: b.name, description: `The ${b.name} ${b.advanced ? 'master class' : 'branch'} of the Firnreach skill tree: every skill, its cost and what it needs.`, order: i + 1 })}
${imp(4)}

${GEN_NOTE}

${card({ section: 'skills', slug: b.slug, name: b.name, kicker, tone: b.advanced ? 'boss' : undefined })}

${b.summary ? `${mdx(b.summary)}\n\n` : ''}The branch's first skill, **${mdx(b.name)}**, costs 1 point, gives **+5 of each resource** at the start of every match
and opens the rest of the branch.

| Skill | What it does | Ranks | Points per rank | Needs |
|---|---|---:|---|---|
${b.nodes.map((n) => {
	const needs = [n.requiresName ? `${mdx(n.requiresName)}${n.requiresRank > 1 ? ` rank ${n.requiresRank}` : ''}` : '', `Level ${n.unlockLevel}`].filter(Boolean).join(', ');
	return `| **${mdx(n.name)}** | ${mdx(n.summary)} | ${n.costs.length} | ${ptsText(n.costs)} | ${needs} |`;
}).join('\n')}

${versionAside}
`;
}
const totalPoints = skillDefs.reduce((s, d) => s + d.costs.reduce((a, c) => a + c, 0), 0);
const skillIndex = `${frontmatter({ title: 'Skill tree', description: 'How the Firnreach skill tree works: skill points, branches, master classes, respec and prestige.', order: 0, label: 'How the tree works' })}
${imp(4)}

${GEN_NOTE}

${card({ name: 'Skill tree', kicker: 'The Trainer', image: false })}

Your **Trainer** in the Hollow keeps the skill tree. You earn **skill points** by leveling up (two a level past
level ${BASE_MAX_LEVEL}) and spend them on skills. Respec is free: every point comes back.

- The tree grows out from your level: each branch opens at a level, and deeper skills can need a higher level still.
- Skills you can't reach yet are hidden in fog until your level and their prerequisite are met.
- At level ${ADV_LEVEL} the **master classes** open, one for each branch plus the Hunter.
- The level cap is ${BASE_MAX_LEVEL}. **Prestige** at the cap starts you over at level 1 with your skills cleared and raises
  the cap by ${PRESTIGE_STEP} (up to ${MAX_PRESTIGE} times). You keep relics, achievements, lifetime stats and your name.

The whole tree costs **${totalPoints} points**.

## Branches

| Branch | Opens at level | Skills |
|---|---:|---|
${skillBranches.filter((b) => !b.advanced).map((b) => `| [${b.name}](/wiki/skills/${b.slug}/) | ${b.unlockLevel} | ${b.nodes.length} |`).join('\n')}

## Master classes

| Class | Opens at level | Skills |
|---|---:|---|
${skillBranches.filter((b) => b.advanced).map((b) => `| [${b.name}](/wiki/skills/${b.slug}/) | ${b.unlockLevel} | ${mdx(b.summary)} |`).join('\n')}

${versionAside}
`;
if (skillBranches.length) writeFolder('skills', [['index.mdx', skillIndex], ...skillBranches.map((b, i) => [`${b.slug}.mdx`, branchPage(b, i)])]);

// ---------------------------------------------------------------- Hollow: shops + stations

const priceText = (e, h) => [e ? `${e} Rime Essence` : '', h ? `${h} Heartstone` : ''].filter(Boolean).join(' + ') || 'Free';
const SHOP_SLUG = { shop_outfit: 'outfitter', shop_pick: 'pick-smith', shop_tower: 'tower-works', shop_supply: 'quartermaster' };
const KIND_NOTE = {
	Cosmetic: 'Cosmetic',
	Supply: 'Supply (used up)',
	PickTip: 'Pick tip',
	PickHandle: 'Pick handle',
	Upgrade: 'Permanent',
};
function shopPage(s, i) {
	const items = shopItems.filter((it) => it.shop === s.id);
	const nm = titleCase(s.title);
	const tips = items.filter((it) => it.kind === 'PickTip');
	const rest = items.filter((it) => it.kind !== 'PickTip');
	return `${frontmatter({ title: nm, description: `${nm}, a shop in the Hollow: ${s.prompt}. Every item, what it does and its price.`, order: i + 1 })}
${imp(4)}

${GEN_NOTE}

${card({ section: 'hollow', slug: SHOP_SLUG[s.id] || slugify(s.title), name: nm, kicker: `Hollow shop · ${titleCase(s.sub)}` })}

Walk up to the counter and press **${KEYS.Interact}** to shop for ${mdx(s.prompt)}. Prices are in **Rime Essence** and
**Heartstone** (see [Crystals and resources](/wiki/resources/)).

| Item | What it does | Type | Price | Most you can own |
|---|---|---|---|---:|
${s.id === 'shop_pick' && handleStandard ? `| **${mdx(handleStandard[1])}** | ${mdx(handleStandard[2])} | Pick handle | Free | 1 |\n` : ''}${rest.map((it) => `| **${mdx(it.name)}** | ${mdx(it.effect)} | ${KIND_NOTE[it.kind] || it.kind} | ${priceText(it.essence, it.heartstone)} | ${it.max} |`).join('\n')}
${tips.length ? `
## Pick tips

${tips.map((t) => `- **${mdx(t.name)}**: ${mdx(t.effect)}`).join('\n')}

Each tip is upgraded one tier at a time. Tier prices (per tip):

| Tier | Pick | Price | Mining speed per tip |
|---:|---|---|---:|
${PICK_TIERS.map((n, k) => ({ tier: k + 1, name: n })).slice(1).map((t) => `| ${t.tier} | ${t.name} | ${priceText(TIP_ESS[t.tier], TIP_HS[t.tier])} | +${Math.round((TIP_SPEED[t.tier] || 0) * 100)}% |`).join('\n')}

See [The pick](/wiki/picks/) for tip focuses.
` : ''}
${items.some((it) => it.kind === 'Supply') ? `Supplies are used up: one of each packed supply goes into your next match. Mark a supply **LEAVE HOME** to keep it for later.\n\n` : ''}${versionAside}
`;
}
const stationRows = stations.filter((st) => !st.id.startsWith('shop_'));
const hollowIndex = `${frontmatter({ title: 'The Hollow', description: 'The Hollow, the underground street you return to between matches: its shops, the Trainer, the library and the other stations.', order: 0, label: 'The street and stations' })}
${imp(4)}

${GEN_NOTE}

${card({ section: 'hollow', slug: 'index', name: 'The Hollow', kicker: 'Between matches' })}

Between matches you're back in the **Hollow**, an underground street under the ice. Walk it in first person; when a
name plate shows your key, press **${KEYS.Interact}** to use that place. What you earned on the ice (Rime Essence and
banked Heartstone) is spent here.

## Shops

| Shop | Sells |
|---|---|
${shopSign.map((s) => `| [${titleCase(s.title)}](/wiki/hollow/${SHOP_SLUG[s.id] || slugify(s.title)}/) | ${mdx(s.prompt.replace(/^./, (c) => c.toUpperCase()))} |`).join('\n')}

## Stations

| Station | What it's for |
|---|---|
${stationRows.map((st) => `| **${titleCase(st.title)}** | ${mdx(st.prompt.replace(/^./, (c) => c.toUpperCase()))}${st.id === 'trainer' ? ' ([skill tree](/wiki/skills/))' : st.id === 'records' ? ' ([list](/wiki/achievements/))' : st.id === 'library' ? ' ([relics](/wiki/relics/))' : st.id === 'radio' ? ' ([online guide](/wiki/playing-online/))' : ''} |`).join('\n')}

${mdx(shopFooter)}

${versionAside}
`;
if (shopSign.length) writeFolder('hollow', [['index.mdx', hollowIndex], ...shopSign.map((s, i) => [`${SHOP_SLUG[s.id] || slugify(s.title)}.mdx`, shopPage(s, i)])]);

// ---------------------------------------------------------------- the pick

const tipItem = shopItems.find((it) => it.kind === 'PickTip');
const handles = shopItems.filter((it) => it.kind === 'PickHandle');
writeRoot('picks.mdx', `${frontmatter({ title: 'The pick', description: 'Your pick in Firnreach: tiers from Basic to Heartstone, the two tips and their focus, and the handles.', order: 5, label: 'The pick' })}
${imp(3)}

${GEN_NOTE}

${card({ section: 'hollow', slug: 'picks', name: 'The pick', kicker: 'Pick Smith' })}

Your pick has **two tips** and a **handle**, all bought and upgraded at the [Pick Smith](/wiki/hollow/pick-smith/).
Each tip has its own tier, and its own **focus**: the resource it brings in more of.

## Tiers

The pick takes its name and look from its tips.

| Tier | Name | Price per tip | Mining speed per tip |
|---:|---|---|---:|
${PICK_TIERS.map((n, k) => `| ${k + 1} | ${n} | ${k === 0 ? 'Starting pick' : priceText(TIP_ESS[k + 1], TIP_HS[k + 1])} | ${k === 0 ? '-' : `+${Math.round((TIP_SPEED[k + 1] || 0) * 100)}%`} |`).join('\n')}

${tipItem ? `${mdx(tipItem.effect)}\n` : ''}
## Tip focus

Pick what each tip focuses on: ${pickFocuses.filter((f) => f !== '?').map((f) => `**${mdx(f)}**`).join(', ')}.

## Handles

| Handle | What it does | Price |
|---|---|---|
${handleStandard ? `| **Standard handle** | ${mdx(handleStandard[2])} | Free |\n` : ''}${handles.map((h) => `| **${mdx(h.name.split(' - ')[0])}** | ${mdx(h.effect)} | ${priceText(h.essence, h.heartstone)} |`).join('\n')}

You can switch between the handles you own at any time at the Pick Smith.

${versionAside}
`);

// ---------------------------------------------------------------- crystals + resources

const COLOR_KEYS = [['Red', 'Red'], ['Purple', 'Purple'], ['Amber', 'Green'], ['Obsidian', 'White']];
writeRoot('resources.mdx', `${frontmatter({ title: 'Crystals and resources', description: 'Red, Purple, Amber and Obsidian crystals, gray rock, Heartstone, Rime Essence and power: what each is for and how you get it.', order: 2, label: 'Crystals and resources' })}
${imp(3)}

${GEN_NOTE}

${card({ section: 'resources', slug: 'crystals', name: 'Crystals and resources', kicker: 'Almanac' })}

## Crystals

You mine four colors of crystal on the ice. Colored crystals always give their own color; **gray rocks** give a few
crystals of a random color.

| Crystal | What it builds |
|---|---|
${COLOR_KEYS.map(([name, k]) => `| **${name}** | ${mdx((buildsLine[k] || '').replace(/^\w+: /, ''))} |`).join('\n')}

Carrying more than your capacity slows you; twice your capacity stops you. Spend crystals on buildings to lighten
the load.

### Mining specialty

${mdx(setupText('Pick a crystal color you mine'))} You choose it on the match setup screen; it is saved with your profile.

## Heartstone

Every boss drops one, and about 1 in 30 gray rocks. It is heavy, and it only counts once you **bank** it: carry it to
your Base and press **${KEYS.Interact}**. Heartstone still in your pocket when the match ends is lost. Banked Heartstone
is spent in the [Hollow's shops](/wiki/hollow/).

## Rime Essence

The pale wisps enemies drop: walk over them before they fade. Every player also earns a wage each time a wave's day
ends. You keep all your Essence on a win and half of what you collected on a loss (the wage is always kept).
Rime Essence is spent in the [Hollow's shops](/wiki/hollow/). Your first win pays a bonus.

## Power

Most buildings run on **power**. Generators make it, Batteries store it and pass it on. You carry your own
**POWER** too: look at a tower and hold **${KEYS.FeedPower}** to feed it, or press **${KEYS.AutoPower}** to auto-feed
the nearest tower that needs it. Your POWER refills at the Base.

## Tips the game gives you

The first time each of these comes up in a match, the game shows the tip:

${hints.map((h) => `- ${mdx(fullNames(h.text))}`).join('\n')}

${versionAside}
`);

// ---------------------------------------------------------------- difficulty + match settings

const ms = matchSettings;
writeRoot('match-settings.mdx', `${frontmatter({ title: 'Difficulty and match settings', description: 'Firnreach difficulty presets (Tutorial to Insane), match lengths from Short to Endless, and the world options.', order: 6, label: 'Difficulty and match settings' })}
${imp(3)}

${GEN_NOTE}

${card({ name: 'Select difficulty', kicker: 'Match setup', image: false })}

The host picks these on the match setup screen before a match (and can change them in the lobby).

## Difficulty

| Preset | What it means |
|---|---|
${ms.presets.map((p) => `| **${p.name}** | ${mdx(p.description)} |`).join('\n')}

On a brand-new profile the **Tutorial** is preselected and marked RECOMMENDED: three gentle waves that teach the
basics step by step.

## Match length

| Length | What it means |
|---|---|
${ms.lengths.map((l) => `| **${l.name}** | ${mdx(l.description)} |`).join('\n')}

## Advanced

- **Prep time:** ${ms.prepSeconds.map((s) => `${s} s`).join(', ')}. The daylight you get to build before the first wave.
- **Upgrade cost:** which crystal pays for your in-match player upgrades at the Base.

| Upgrade cost | What it means |
|---|---|
${ms.upgradeCost.map((u) => `| **${u.name}** | ${mdx(u.description)} |`).join('\n')}

## World

| Option | Choices |
|---|---|
| Safe zone | ${ms.safeZone.map((v) => `${v} x ${v} cells`).join(', ')} |
| Rock coverage | ${ms.coverage.map((v) => `${v}%`).join(', ')} |
| Crystals | ${ms.crystals.map((v) => `${v}% of rocks`).join(', ')} |
| Map | Random every match, or a fixed map |
| Secrets on the ice | On: ${mdx(setupText('Relics and echo stones can turn up'))} Off: ${mdx(setupText('A plain match'))} |

## The deep lift

*${mdx(setupText('Something hums below the Sealed Gate'))}* Mend its brake in the deep workshop behind the
Sealed Gate, and a match can ride it down instead of playing on the surface ice:

${mdx(setupText('Darker, more rock and ice'))}

${versionAside}
`);

// ---------------------------------------------------------------- controls

const keySectionOrder = [...new Set(keybinds.map((k) => k.section))];
writeRoot('controls.mdx', `${frontmatter({ title: 'Controls', description: 'Every default key binding in Firnreach: general, first person, build mode and the commander view.', order: 7, label: 'Controls' })}
${imp(3)}

${GEN_NOTE}

${card({ name: 'Controls', kicker: 'Settings', image: false })}

The default keys. Every one can be rebound in **Settings**, and **Esc** always opens the pause menu.
Press **${KEYS.Help || 'H'}** in a match to show or hide the controls panel.

${keySectionOrder.map((sec) => `## ${titleCase(sec).replace(/\(rts View\)/i, '(RTS view)').replace(/\(first Person\)/i, '(first person)')}

| Action | Key |
|---|---|
${keybinds.filter((k) => k.section === sec).map((k) => `| ${mdx(k.action)} | **${mdx(k.key)}** |`).join('\n')}
`).join('\n')}
${versionAside}
`);

console.log(`Exported from ${TAG} (${tagDate}): ${towers.length} buildings, ${enemies.length} enemies, ${relics.length} relics, `
	+ `${achievements.length} achievements, ${skillDefs.length} skills in ${skillBranches.length} branches, ${shopItems.length} shop items `
	+ `in ${shopSign.length} shops, ${stations.length} stations, ${keybinds.length} key bindings, ${hints.length} hints, `
	+ `${ms.presets.length} presets, ${news.length} news posts.`);
