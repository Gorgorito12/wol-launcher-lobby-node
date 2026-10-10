/**
 * How `scripts/admin.ts` reads its command line, kept apart so it can be tested without loading
 * the script (which opens databases and reads .env).
 */

/**
 * The flags that take a value, as `--flag value` as well as `--flag=value`. Their value is
 * neither the command, nor a positional, nor the database path — it used to be all three: the
 * db path is recognised by SHAPE (anything with a slash), so `replay:attach <id> --file /tmp/x`
 * opened the recording as the database, and a `--reason` with a slash in it did the same.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
    'days', 'file', 'from-season', 'kind', 'limit', 'losers', 'older-than', 'player',
    'reason', 'refund-since', 'since', 'to', 'winner',
]);

/** The arguments that are neither a flag nor a flag's value, in order. */
export function bareArgsOf(argv: readonly string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a.startsWith('--')) {
            if (!a.includes('=') && VALUE_FLAGS.has(a.slice(2))
                && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) i++;
            continue;
        }
        out.push(a);
    }
    return out;
}

/** The database path is recognised by shape: it is the only bare argument that looks like a path. */
export function looksLikeDbPath(a: string): boolean {
    return a.endsWith('.db') || a.includes('/') || a.includes('\\');
}
