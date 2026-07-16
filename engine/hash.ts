/**
 * Pick-commit hashing (invariant I2).
 *
 * pick_hash = sha256(canonical JSON of the pick). "Canonical" = keys sorted
 * recursively and numbers serialized deterministically, so the same logical
 * pick always hashes to the same value regardless of key insertion order.
 * The served pick JSON is stored verbatim and must re-hash to the stored value.
 */
import { createHash } from 'node:crypto';

/**
 * Deterministic JSON stringify: object keys sorted lexicographically at every
 * depth; arrays preserved in order. Numbers use JS default serialization (the
 * engine rounds to fixed precision before hashing, so this is stable).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortDeep(obj[key]);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical JSON. */
export function pickHash(pick: unknown): string {
  return createHash('sha256').update(canonicalize(pick), 'utf8').digest('hex');
}

/** sha256 hex of an arbitrary string (used for Merkle leaves / anchors). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Verify a served pick JSON string re-hashes to an expected hash (I2 auditor
 * check). Returns { ok, actual }.
 */
export function verifyPickHash(rawJson: string, expected: string): { ok: boolean; actual: string } {
  const parsed = JSON.parse(rawJson);
  const actual = pickHash(parsed);
  return { ok: actual === expected, actual };
}
