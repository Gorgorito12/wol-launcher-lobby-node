/**
 * Source scans that keep the ladder honest. Run: `npm test`.
 *
 * <p>Every rule here is about code that does not exist yet — the next query somebody writes — and
 * every one fails silently: nothing throws, the numbers are just wrong. That is why they are scans
 * of the source rather than tests of a function.</p>
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
        // place a match in time by writing its created_at.
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.startsWith('test-')) {
            out.push(path);
        }
    }
    return out;
}

const FILES = [...sources(join(process.cwd(), 'src')), ...sources(join(process.cwd(), 'scripts'))];

test('the scan sees the code it is meant to guard', () => {
    // A scan of nothing passes for ever.
    assert.ok(FILES.some((f) => f.endsWith(join('elo', 'ladder.ts'))), 'ladder.ts');
    assert.ok(FILES.some((f) => f.endsWith(join('scripts', 'admin.ts'))), 'admin.ts');
});

test('THE ONE THAT MATTERS: nothing reads or writes a frozen ratings table', () => {
    // `elo_ratings` was frozen by 0024 and `season_ratings` by 0025. A query against either reads
    // ratings from an older system and shows them as today's: no error, just a stale number on one
    // surface while every other surface shows the live ladder. Only SQL shapes are forbidden;
    // prose that mentions the tables is fine.
    for (const table of [['elo', 'ratings'].join('_'), ['season', 'ratings'].join('_')]) {
        const shape = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`, 'i');
        const offenders = FILES.filter((f) => shape.test(readFileSync(f, 'utf8')));
        assert.deepEqual(offenders, [], `still querying ${table}: ${offenders.join(', ')}`);
    }
});

test('a match\'s instant comes from SQLite\'s own clock: nothing writes matches.created_at', () => {
    // created_at orders the replay, decays every deviation and walks the anti-farm chain, and it
    // is compared as TEXT in datetime('now') form. A value supplied in any other format, or from a
    // client clock, would put a match in the wrong place on the timeline, silently.
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

test('a refund\'s place on the timeline is the server\'s own clock too', () => {
    const insert = /INSERT\s+INTO\s+ban_refunds\s*\(([^)]*)\)/gi;
    const offenders: string[] = [];
    for (const f of FILES) {
        for (const m of readFileSync(f, 'utf8').matchAll(insert)) {
            if (/\bcreated_at\b/.test(m[1]!)) offenders.push(f);
        }
    }
    assert.deepEqual(offenders, []);
});

test('nothing rates a match except rateStoredMatch', () => {
    // A second writer of player_ratings is how the live ladder and its replay come to disagree.
    // The ladder module owns the upsert; refunds add points in the same module; admin's reset is
    // the only other writer and it deletes.
    const shape = /\b(INSERT\s+INTO|UPDATE)\s+player_ratings\b/i;
    const offenders = FILES.filter((f) => shape.test(readFileSync(f, 'utf8')))
        .filter((f) => !f.endsWith(join('elo', 'ladder.ts')));
    assert.deepEqual(offenders, [], `writes player_ratings outside ladder.ts: ${offenders.join(', ')}`);
});
