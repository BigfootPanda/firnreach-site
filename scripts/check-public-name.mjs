// Fails the build if the internal project name appears anywhere in the built site (public name: Firnreach).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const BAD = /frostborn/i;
const TEXT = /\.(html|js|css|json|xml|txt|svg|md)$/i;
const hits = [];
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (TEXT.test(name) && BAD.test(readFileSync(p, 'utf8'))) hits.push(p);
	}
})(DIST);
if (hits.length) {
	console.error(`Internal project name found in ${hits.length} built file(s):\n  ${hits.join('\n  ')}`);
	process.exit(1);
}
console.log('check-public-name: OK (no internal name in dist/)');
