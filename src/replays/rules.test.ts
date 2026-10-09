import test from 'node:test';
import assert from 'node:assert/strict';
import { objectKeyFor, replayFileName, replayView, reporterRefusal, uploadRefusal, REPLAY_RETENTION_DAYS, type ReplayMatchRow } from './rules';

const SHA = 'a'.repeat(64);

function match(overrides: Partial<ReplayMatchRow> = {}): ReplayMatchRow {
    return {
        id: 'm1',
        host_user_id: 'host',
        mod_id: 'wol',
        started_at: '2026-10-09T18:00:00.000Z',
        replay_sha256: SHA,
        replay_key: null,
        replay_size_bytes: null,
        competitive: 1,
        ...overrides,
    };
}

function refusal(overrides: Partial<Parameters<typeof uploadRefusal>[0]> = {}) {
    return uploadRefusal({
        match: match(),
        callerId: 'host',
        sizeBytes: 1_500_000,
        sha256: SHA,
        maxBytes: 20 * 1024 * 1024,
        ...overrides,
    });
}

// ---- the refusals are the point ---------------------------------------------------------

test('no such match', () => {
    assert.equal(refusal({ match: null })?.code, 'not_found');
});

test('a casual room keeps no recording', () => {
    assert.equal(refusal({ match: match({ competitive: 0 }) })?.code, 'not_competitive');
});

test('a match whose lobby row is gone is not assumed competitive', () => {
    assert.equal(refusal({ match: match({ competitive: null }) })?.code, 'not_competitive');
});

test('only the reporter may upload — not the opponent, not a stranger', () => {
    const r = refusal({ callerId: 'guest' });
    assert.equal(r?.code, 'not_reporter');
    assert.equal(r?.status, 403);
});

test('a size that is missing, zero, negative, fractional or text is refused', () => {
    for (const size of [undefined, null, 0, -5, 1.5, '1500', Number.NaN]) {
        assert.equal(refusal({ sizeBytes: size })?.code, 'bad_request', `size ${String(size)}`);
    }
});

test('a recording past the cap is refused with the cap named', () => {
    const r = refusal({ sizeBytes: 20 * 1024 * 1024 + 1 });
    assert.equal(r?.code, 'too_large');
    assert.equal(r?.status, 413);
    assert.equal(r?.details?.max_bytes, 20 * 1024 * 1024);
});

test('a different recording than the one reported is refused', () => {
    assert.equal(refusal({ sha256: 'b'.repeat(64) })?.code, 'sha_mismatch');
});

test('a malformed fingerprint is a bad request, not a mismatch', () => {
    assert.equal(refusal({ sha256: 'not-a-hash' })?.code, 'bad_request');
    assert.equal(refusal({ sha256: 42 })?.code, 'bad_request');
});

test('a second upload is refused', () => {
    assert.equal(refusal({ match: match({ replay_key: 'replays/wol/2026/m1.age3Yrec' }) })?.code, 'already_uploaded');
});

// ---- what is accepted --------------------------------------------------------------------

test('the reporter of a competitive match with the reported recording is accepted', () => {
    assert.equal(refusal(), null);
});

test('the fingerprint comparison ignores case', () => {
    assert.equal(refusal({ sha256: SHA.toUpperCase() }), null);
});

test('a match reported before its recording turned up accepts the late file', () => {
    assert.equal(refusal({ match: match({ replay_sha256: null }), sha256: 'c'.repeat(64) }), null);
});

test('the fingerprint is optional', () => {
    assert.equal(refusal({ sha256: undefined }), null);
});

test('confirm uses the same three gates', () => {
    assert.equal(reporterRefusal(null, 'host')?.code, 'not_found');
    assert.equal(reporterRefusal(match({ competitive: 0 }), 'host')?.code, 'not_competitive');
    assert.equal(reporterRefusal(match(), 'guest')?.code, 'not_reporter');
    assert.equal(reporterRefusal(match(), 'host'), null);
});

// ---- object keys ------------------------------------------------------------------------

test('the key is mod / year / match id', () => {
    assert.equal(objectKeyFor('wol', '2026-10-09T18:00:00Z', 'm1'), 'replays/wol/2026/m1.age3Yrec');
});

test('nothing in the key can climb out of its folder', () => {
    const key = objectKeyFor('../../etc', '2026-01-01', '../x/../y');
    assert.ok(!key.includes('..'), key);
    assert.match(key, /^replays\/[a-z0-9-]+\/2026\/[A-Za-z0-9-]+\.age3Yrec$/);
});

test('a start time that is not a date falls back to the current year', () => {
    assert.equal(objectKeyFor('wol', 'garbage', 'm1', new Date('2027-03-01T00:00:00Z')), 'replays/wol/2027/m1.age3Yrec');
});

// ---- download names ---------------------------------------------------------------------

test('a 1v1 is date, both names, map', () => {
    assert.equal(
        replayFileName('2026-10-09T18:00:00Z', [{ name: 'Ana', team: 0 }, { name: 'Luis', team: 0 }], 'ESOC Fertile Crescent', 'm1'),
        '2026-10-09_Ana-vs-Luis_ESOC_Fertile_Crescent.age3Yrec',
    );
});

test('a team game names the first player of each side', () => {
    const players = [
        { name: 'A1', team: 0 }, { name: 'A2', team: 0 },
        { name: 'B1', team: 1 }, { name: 'B2', team: 1 },
    ];
    assert.equal(replayFileName('2026-10-09', players, 'Texas', 'm1'), '2026-10-09_A1-vs-B1_Texas.age3Yrec');
});

test('quotes, slashes, dots and accents never reach the file name', () => {
    const name = replayFileName('2026-10-09', [{ name: 'José "x"/..\\', team: 0 }, { name: 'Ñandú', team: 0 }], '../Mapa', 'm1');
    assert.match(name, /^[A-Za-z0-9._-]+$/);
    assert.ok(!name.includes('..'), name);
    assert.equal(name, '2026-10-09_Jose_x-vs-Nandu_Mapa.age3Yrec');
});

test('with nothing usable the match id names the file', () => {
    assert.equal(replayFileName(null, [{ name: '???', team: 0 }], '', 'abc-123'), 'abc-123.age3Yrec');
});

test('a very long name is capped', () => {
    const long = 'x'.repeat(400);
    const name = replayFileName('2026-10-09', [{ name: long, team: 0 }], long, 'm1');
    assert.ok(name.length <= 120 + '.age3Yrec'.length, String(name.length));
    assert.ok(name.endsWith('.age3Yrec'));
});

// ---------------------------------------------------------------------------
// replayView — what every match list says about a recording
// ---------------------------------------------------------------------------

test('the retention matches the bucket lifecycle rule', () => {
    assert.equal(REPLAY_RETENTION_DAYS, 365);
});

test('a stored recording inside its year is available, with its size and expiry', () => {
    const v = replayView(
        { replay_key: 'replays/wol/2026/m1.age3Yrec', replay_uploaded_at: '2026-10-09 18:00:00', replay_size_bytes: 1_400_000 },
        new Date('2026-10-10T00:00:00Z'),
    );
    assert.deepEqual(v, { has_replay: true, replay_expires_at: '2027-10-09T18:00:00Z', replay_size_bytes: 1_400_000 });
});

test('never recorded: no replay and no expiry', () => {
    assert.deepEqual(replayView({ replay_key: null, replay_uploaded_at: null, replay_size_bytes: null }),
        { has_replay: false, replay_expires_at: null, replay_size_bytes: null });
    assert.deepEqual(replayView({}), { has_replay: false, replay_expires_at: null, replay_size_bytes: null });
});

test('past its year it is EXPIRED even while the key is still there', () => {
    const v = replayView(
        { replay_key: 'k', replay_uploaded_at: '2025-10-09 18:00:00', replay_size_bytes: 10 },
        new Date('2026-10-09T18:00:01Z'),
    );
    assert.equal(v.has_replay, false);
    assert.equal(v.replay_expires_at, '2026-10-09T18:00:00Z');
    assert.equal(v.replay_size_bytes, null);
});

test('a key the download route cleared still reads as expired, never as never-recorded', () => {
    const v = replayView({ replay_key: null, replay_uploaded_at: '2026-01-01 00:00:00', replay_size_bytes: null },
        new Date('2026-06-01T00:00:00Z'));
    assert.equal(v.has_replay, false);
    assert.notEqual(v.replay_expires_at, null);
});

test('a key with no upload date is offered rather than hidden', () => {
    assert.equal(replayView({ replay_key: 'k', replay_uploaded_at: null, replay_size_bytes: 5 }).has_replay, true);
});
