import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const local=createRequire(import.meta.url);
// Desktop development can reuse preinstalled runtimes when disk space is constrained.
// A normal deployment resolves everything from this app's npm dependencies first.
const candidates=[...(process.env.AUDIT_NODE_MODULES||'').split(';').filter(Boolean),resolve(fileURLToPath(new URL('../../.tmp/audit-runtime/node_modules',import.meta.url))),process.env.USERPROFILE?join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'):null].filter(Boolean);
export function dependency(name){try{return local(name);}catch(error){for(const dir of candidates){try{return createRequire(join(dir,'__storelens_resolver__.cjs'))(name);}catch{}}throw error;}}
