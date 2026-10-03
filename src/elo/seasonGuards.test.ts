/**
 * Two source scans that keep seasons honest. Run: `npm test`.
 *
 * <p>Both rules are about code that does not exist yet — the next query somebody writes — and
 * both fail silently: nothing throws, the numbers are just wrong. That is why they are scans of
 * the source rather than tests of a function.</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) out.push(...sources(path));
        // The tests themselves are skipped: they quote the forbidden shapes to forbid them. So
        // are the scripts/test-*.ts harnesses, which build fixture databases and must be able to
        // place a match in a season by writing its created_at.
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.startsWith('test-')) {
            out.push(path);
        }
    }
    return out;
}

const FILES = [...sources(join(process.cwd(), 'src')), ...sources(join(process.cwd(), 'scripts'))];

test('the scan sees the code it is meant to guard', () => {
    // A scan of nothing passes for ever.
    assert.ok(FILES.some((f) => f.endsWith(join('elo', 'glicko2.ts'))), 'glicko2.ts');
    assert.ok(FILES.some((f) => f.endsWith(join('scripts', 'admin.ts'))), 'admin.ts');
});

test('THE ONE THAT MATTERS: nothing reads or writes the pre-season ratings table', () => {
    // `elo_ratings` was frozen by migration 0024. A query against it reads ratings from before
    // seasons existed and shows them as today's — no error, just a stale number on one surface
    // while every other surface shows the season's. Only SQL shapes are forbidden; prose that
    // mentions the table is fine.
    const table = ['elo', 'ratings'].join('_');
    const shape = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`, 'i');
    const offenders = FILES.filter((f) => shape.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, [], `still querying ${table}: ${offenders.join(', ')}`);
});

test('a match\'s season comes from SQLite\'s own clock: nothing writes matches.created_at', () => {
    // Season bounds are compared as TEXT against created_at, which datetime('now') writes as
    // 'YYYY-MM-DD HH:MM:SS'. An INSERT that supplied an ISO value would sort after every value
    // of the same day whatever its time — a match filed into the wrong season, silently. And a
    // client-supplied clock is exactly what the season must never depend on.
    const insert = /INSERT\s+INTO\s+matches\s*\(([^)]*)\)/gi;
    const offenders: string[] = [];
    let seen = 0;
    for (const f of FILES) {
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(insert)) {
            seen++;
            if (/\bcreated_at\b/.test(m[1]!)) offenders.push(f);
        }
    }
    assert.ok(seen >= 2, `expected the report and the founding inserts, found ${seen}`);
    assert.deepEqual(offenders, []);
});
