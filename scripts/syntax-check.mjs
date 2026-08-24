// Syntax-check every .ts in the backend WITHOUT installing anything.
//
// Run:  node scripts/syntax-check.mjs src
//
// On a Windows box with no Node of its own, VS Code's Electron IS one:
//   $env:ELECTRON_RUN_AS_NODE = "1"
//   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" scripts/syntax-check.mjs src
//
// Why this exists: a single stray newline inside a regex literal in env.ts once
// took the whole service down. A syntax error stops the module loading, so the
// process died before it could listen and nginx answered 502 to every request —
// with nothing in the app logs, because the app never ran. It shipped because the
// machine it was written on had no way to parse TypeScript at all.
//
// Known false positive: lib/errors.ts uses a constructor parameter property, which
// Node's strip-only mode refuses on principle (it would need to emit code, not just
// erase types). That file is fine; ignore it.
//
// Node 24 (borrowed from the VS Code install via ELECTRON_RUN_AS_NODE) can strip
// TypeScript types itself, and once the types are gone the result is plain ESM that
// the parser will accept or reject. This does NOT typecheck — it catches the class
// of error that took the server down: a syntax error that stops a module loading.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
const tmp = join(process.env.TEMP || '/tmp', 'tscheck-out');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
    }
})(root);

let bad = 0;
for (const f of files) {
    const rel = relative(root, f);
    let js;
    try {
        js = stripTypeScriptTypes(readFileSync(f, 'utf8'), { mode: 'strip' });
    } catch (e) {
        console.log(`FAIL  ${rel}\n      (type strip) ${e.message}`);
        bad++;
        continue;
    }
    const out = join(tmp, rel.replace(/[\\/]/g, '_') + '.mjs');
    writeFileSync(out, js);
    try {
        execFileSync(process.execPath, ['--check', out], {
            stdio: 'pipe',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        console.log(`ok    ${rel}`);
    } catch (e) {
        const msg = (e.stderr?.toString() || e.message).split('\n').slice(0, 6).join('\n      ');
        console.log(`FAIL  ${rel}\n      ${msg}`);
        bad++;
    }
}

console.log(`\n${files.length} archivos, ${bad} con error de sintaxis`);
process.exit(bad === 0 ? 0 : 1);
