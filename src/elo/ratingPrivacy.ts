/**
 * Who keeps his rating private (migration 0034, the launcher's "Show my ELO" switched off).
 *
 * <p>An in-memory set, loaded once at start ({@link loadRatingPrivacy}) and changed only by the
 * route that writes the column ({@link setRatingPrivate}), so the redactors in
 * ./placementPrivacy.ts can ask by owner id without a query — they run on every room frame and
 * every list. A LEAF: it imports nothing, so any module may use it without opening a cycle.</p>
 *
 * <p>The admin CLI is another process and does not reach this set; it must not write the column,
 * or the running server would disagree with the database until its next restart.</p>
 */

const privateIds = new Set<string>();

/** Whether this player keeps his rating to himself. */
export function isRatingPrivate(userId: string | null | undefined): boolean {
    return typeof userId === 'string' && userId !== '' && privateIds.has(userId);
}

/** Record a change made through POST /me/rating-visibility (after the row was written). */
export function setRatingPrivate(userId: string, isPrivate: boolean): void {
    if (isPrivate) privateIds.add(userId);
    else privateIds.delete(userId);
}

/** Fill the set from the database; called once at start. Best-effort: a failure leaves it empty. */
export async function loadRatingPrivacy(db: {
    prepare(sql: string): { bind(...p: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
}): Promise<number> {
    privateIds.clear();
    try {
        const rows = await db.prepare('SELECT id FROM users WHERE rating_private = 1').bind()
            .all<{ id: string }>();
        for (const r of rows.results ?? []) privateIds.add(r.id);
    } catch {
        // A database without the column yet (it is added by the migration that runs first).
    }
    return privateIds.size;
}

/** Tests only. */
export function resetRatingPrivacyForTests(): void {
    privateIds.clear();
}
