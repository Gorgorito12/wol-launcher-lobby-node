/**
 * Comparing launcher version tags, so the server can refuse a client that is too old.
 *
 * <p><b>This mirrors a rule that already exists on the client</b> —
 * <c>LauncherUpdateService.TryParseSemVer</c> — and it has to mirror it EXACTLY, because the
 * two answer the same question from opposite ends: the launcher uses it to decide whether an
 * update is newer, and this uses it to decide whether a client may play. If they disagree, a
 * player is told they are up to date and refused entry in the same breath.</p>
 *
 * <p><b>The part that is not ordinary SemVer: a trailing LETTER.</b> The project ships tags like
 * <c>v1.0.12e</c>, and the ordering is
 * <c>1.0.5 &lt; 1.0.5a &lt; 1.0.5b &lt; 1.0.6</c> — the letter is a suffix WITHIN a patch, not a
 * pre-release marker. Treating it as SemVer prerelease would invert that and lock out the newest
 * clients while letting older ones in.</p>
 *
 * <p>Pure and side-effect free.</p>
 */

/** A parsed tag. `letter` is 0 for no suffix, 1 for `a`, 2 for `b`, … 27 for `aa`. */
export interface LauncherVersion {
    major: number;
    minor: number;
    patch: number;
    letter: number;
}

/**
 * Rank of a trailing letter suffix, base-26. Change this and you change the whole ordering.
 *
 * <p>No letter is 0, so a plain `1.0.5` sorts BEFORE `1.0.5a`, which is what the project's own
 * release history means by those tags.</p>
 */
export function letterRank(suffix: string): number {
    let rank = 0;
    for (const ch of suffix.toLowerCase()) {
        const v = ch.charCodeAt(0) - 96;   // 'a' -> 1
        if (v < 1 || v > 26) return 0;
        rank = rank * 26 + v;
    }
    return rank;
}

/**
 * Parse `v1.0.12e` / `1.0.12` / `v2.3` into a comparable version, or null when it is not a tag
 * we understand.
 *
 * <p>Returning null rather than guessing matters: the caller treats "cannot tell" as a refusal
 * only because a refusal is recoverable (update, or ask), whereas admitting an unknown client
 * on a protocol that has changed is the thing this exists to prevent.</p>
 */
export function parseLauncherVersion(tag: string | null | undefined): LauncherVersion | null {
    if (!tag) return null;
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?([A-Za-z]*)$/.exec(tag.trim());
    if (!m) return null;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: m[3] === undefined ? 0 : Number(m[3]),
        letter: letterRank(m[4] ?? ''),
    };
}

/** Negative when a &lt; b, 0 when equal, positive when a &gt; b. */
export function compareLauncherVersions(a: LauncherVersion, b: LauncherVersion): number {
    return a.major - b.major
        || a.minor - b.minor
        || a.patch - b.patch
        || a.letter - b.letter;
}

/**
 * Whether a client reporting <paramref name="clientTag"/> satisfies <paramref name="minTag"/>.
 *
 * <p><b>An empty minimum means the requirement is OFF</b>, and everything passes. That is the
 * default, and it is what keeps this feature harmless until somebody deliberately turns it
 * on.</p>
 *
 * <p><b>A client that sends nothing, or something unparseable, does NOT satisfy a minimum.</b>
 * It can only be a build from before clients started reporting their version — which is exactly
 * the population a minimum is meant to exclude. The cost of getting this backwards is worth
 * stating: set a minimum before the first version that REPORTS one has shipped, and you lock out
 * every player at once. See DEPLOY.md.</p>
 */
export function meetsMinimum(clientTag: string | null | undefined, minTag: string): boolean {
    const min = parseLauncherVersion(minTag);
    if (!min) return true;   // no requirement configured (or an unusable one): allow everybody

    const client = parseLauncherVersion(clientTag);
    if (!client) return false;

    return compareLauncherVersions(client, min) >= 0;
}
