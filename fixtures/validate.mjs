// T-008: self-check for the ingest fixture set. No dependencies, no network.
//   node fixtures/validate.mjs
// Fails (exit 1) if a file is unparsable, the required coverage is missing,
// or anything credential-shaped appears in the fixtures.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIRS = { pumpportal: 20, helius: 1 }; // minimum required file counts
const CREDENTIAL_PATTERNS = [
  /api[-_]?key\s*[=:]/i,
  /x-api-key/i,
  /authorization:/i,
  /\bbearer\s+[A-Za-z0-9._-]{8,}/i,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\bcpk_[A-Za-z0-9]{8,}/,
];
const INJECTION = /ignore (all )?previous instructions/i;

const failures = [];
const fail = (msg) => failures.push(msg);

function load(dir) {
  const base = join(HERE, dir);
  return readdirSync(base)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const text = readFileSync(join(base, file), 'utf8');
      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        fail(`${dir}/${file}: invalid JSON — ${err.message}`);
      }
      return { dir, file, text, json };
    });
}

const strings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
};

const messages = (docs) => docs.filter((d) => d.dir === 'pumpportal' && d.json && !Array.isArray(d.json));
const txTypes = (docs) => messages(docs).map((m) => m.json.txType).filter((t) => typeof t === "string");

const docs = [...load('pumpportal'), ...load('helius')];
for (const dir of Object.keys(DIRS)) {
  const n = docs.filter((d) => d.dir === dir).length;
  if (n < DIRS[dir]) fail(`${dir}/: ${n} JSON files, need at least ${DIRS[dir]}`);
}

// --- required coverage -------------------------------------------------------
const types = txTypes(docs);
for (const kind of ['create', 'buy', 'sell', 'migrate']) {
  if (!types.includes(kind)) fail(`pumpportal/: no "${kind}" message`);
}
if (!messages(docs).some((m) => m.json.method?.startsWith('subscribe'))) {
  fail('pumpportal/: no subscribe frame');
}

const malformed = docs.filter((d) => d.dir === 'pumpportal' && d.file.startsWith('malformed-'));
if (malformed.length < 4) fail(`pumpportal/: only ${malformed.length} malformed-* fixtures`);
if (!malformed.some((d) => typeof d.json !== 'object')) fail('pumpportal/: no non-object (raw frame) malformed fixture');

// Byte-identical twins (e.g. create-duplicate-of.json == create-normal.json) must also share a
// signature, otherwise "duplicate" would not exercise signature-level idempotency.
const byText = new Map();
for (const m of messages(docs)) byText.set(m.text, [...(byText.get(m.text) ?? []), m]);
const twins = [...byText.values()].filter((group) => group.length > 1);
if (twins.length < 2) fail('pumpportal/: expected at least 2 byte-identical duplicate fixtures');
for (const group of twins) {
  const sigs = new Set(group.map((m) => m.json.signature));
  if (sigs.size !== 1 || sigs.has(undefined)) {
    fail(`pumpportal/: duplicate ${group.map((m) => m.file).join(' + ')} must share one signature`);
  }
}

const injection = docs.filter((d) => strings(d.json).some((s) => INJECTION.test(s)));
if (injection.length < 2) fail(`pumpportal/: only ${injection.length} prompt-injection-looking fixtures, need 2`);
for (const d of injection) {
  if (d.dir !== 'pumpportal') fail(`${d.dir}/${d.file}: injection strings belong in pumpportal/ token metadata`);
}

const metadata = messages(docs).filter((m) => m.json.txType === 'create');
const oversized = metadata.filter(
  (m) => (m.json.name?.length ?? 0) > 64 || (m.json.symbol?.length ?? 0) > 16 || (m.json.uri?.length ?? 0) > 200,
);
if (!oversized.length) fail('pumpportal/: no fixture that exceeds the metadata clamps');
if (!metadata.some((m) => /[^\u0000-\u007f]/.test(m.json.name ?? '') && /[\u007f-\uffff]/.test(m.json.name ?? ''))) {
  fail('pumpportal/: no unicode metadata fixture');
}
if (!metadata.some((m) => /[\u0000-\u001f\u007f]/.test(JSON.stringify(strings(m.json))))) {
  fail('pumpportal/: no control-character fixture');
}

const funding = docs.filter((d) => d.dir === 'helius' && d.json && !Array.isArray(d.json) && 'funder' in d.json);
if (!funding.some((d) => d.json.funder && d.json.mint && d.json.signature && d.json.amountRaw)) {
  fail('helius/: no complete funded-by response');
}
const enhanced = docs.filter((d) => d.dir === 'helius' && Array.isArray(d.json));
if (!enhanced.some((d) => d.json.some((tx) => tx.nativeTransfers?.length))) {
  fail('helius/: no enhanced transaction with nativeTransfers');
}
if (!enhanced.some((d) => d.json.some((tx) => tx.transactionError))) {
  fail('helius/: no failed (transactionError) enhanced transaction');
}

// --- safety ------------------------------------------------------------------
for (const d of docs) {
  if (d.text.length > 32 * 1024) fail(`${d.dir}/${d.file}: ${d.text.length} bytes, keep fixtures small`);
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(d.text)) fail(`${d.dir}/${d.file}: matches forbidden pattern ${pattern}`);
  }
}

// --- report ------------------------------------------------------------------
const counts = Object.keys(DIRS).map((dir) => `${dir}=${docs.filter((d) => d.dir === dir).length}`);
console.log(`fixtures: ${counts.join(' ')} (${docs.length} files)`);
console.log(`coverage: txTypes=${[...new Set(types)].join(',')}`);
console.log(`          duplicates=${twins.length} injection=${injection.length} malformed=${malformed.length} oversized=${oversized.length} heliusEnhanced=${enhanced.length}`);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log('OK: all fixtures parse, coverage complete, no credential-shaped strings');
