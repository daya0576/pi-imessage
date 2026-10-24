// Explicit operator pairing only; no model tool exposes login/MFA or session keys.
import { resolve } from 'node:path';
import { createBitwarden } from '../src/extensions/bitwarden.ts';
if (process.argv.length !== 3) throw new Error('Usage: node --experimental-strip-types ops/bitwarden-login.mjs PRIVATE_CONFIG_PATH');
const broker = createBitwarden(resolve(process.argv[2]), {
 async owner() { throw new Error('No model access during operator pairing'); },
 async fill() { throw new Error('No browser filling during operator pairing'); },
});
try { console.log(JSON.stringify(await broker.initialize())); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await broker.close(); }
