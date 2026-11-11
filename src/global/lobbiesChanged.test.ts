/**
 * The `lobbies_changed` frame's batching. Run: `npm test`.
 *
 * Every launcher with its Rooms page open asks `/lobbies` when it gets this frame, so the number
 * of frames IS the number of request bursts. A room filling up is several changes in a moment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LobbiesChangedBatcher, noteLobbiesChanged, onLobbiesChanged, setLobbiesChangedSink, type LobbiesChangedFrame,
} from './lobbiesChanged.js';

function manual() {
    const sent: LobbiesChangedFrame[] = [];
    const scheduled: (() => void)[] = [];
    const batcher = new LobbiesChangedBatcher((f) => sent.push(f), 1000, (fn) => { scheduled.push(fn); return 0; });
    return { sent, scheduled, batcher };
}

test('THE ONE THAT MATTERS: changes inside the second go out as one frame', () => {
    const { sent, scheduled, batcher } = manual();
    batcher.note(); batcher.note(); batcher.note();
    assert.equal(scheduled.length, 1, 'only the first note schedules');
    assert.equal(sent.length, 0);
    scheduled[0]!();
    assert.deepEqual(sent, [{ type: 'lobbies_changed' }]);
});

test('a change after the frame went schedules the next one', () => {
    const { sent, scheduled, batcher } = manual();
    batcher.note(); scheduled[0]!();
    batcher.note();
    assert.equal(scheduled.length, 2);
    scheduled[1]!();
    assert.equal(sent.length, 2);
});

test('a failing socket never reaches the room that changed', () => {
    const batcher = new LobbiesChangedBatcher(() => { throw new Error('socket'); }, 1000, (fn) => { fn(); return 0; });
    assert.doesNotThrow(() => batcher.note());
    setLobbiesChangedSink(() => { throw new Error('sink'); });
    assert.doesNotThrow(() => noteLobbiesChanged());
    setLobbiesChangedSink(null);
    assert.doesNotThrow(() => noteLobbiesChanged());
});

test('THE ONE THAT MATTERS: a change drops the cached room list before anybody is told', () => {
    // The woken launchers ask within half a second; a list memo from before the change would hand
    // them a list without the new room and leave them waiting for the next poll.
    const order: string[] = [];
    onLobbiesChanged(() => order.push('forget'));
    onLobbiesChanged(() => { throw new Error('a broken cache'); });
    setLobbiesChangedSink(() => order.push('frame'));
    assert.doesNotThrow(() => noteLobbiesChanged());
    assert.deepEqual(order, ['forget', 'frame']);
    setLobbiesChangedSink(null);
});
