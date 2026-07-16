/**
 * Minimal sha256 Merkle tree over pick hashes (invariant I5 + LedgerAnchor).
 *
 * Leaves are the hex `pick_hash` values. A parent hashes the concatenation of
 * its two children's hex strings. An odd node at any layer pairs with itself.
 * The daily root is what `LedgerAnchor.postAnchor(day, root, count)` commits
 * on-chain; `GET /api/anchor/:day` serves proofs that fold back to that root.
 */
import { sha256Hex } from './hash';

export function hashPair(left: string, right: string): string {
  return sha256Hex(left + right);
}

export interface MerkleTree {
  root: string;
  layers: string[][]; // layers[0] = leaves, last = [root]
  count: number;
}

export function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    const empty = sha256Hex('EDGELEDGER_EMPTY');
    return { root: empty, layers: [[empty]], count: 0 };
  }
  const layers: string[][] = [leaves.slice()];
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // odd → self-pair
      next.push(hashPair(left, right));
    }
    layers.push(next);
    level = next;
  }
  return { root: level[0], layers, count: leaves.length };
}

export function merkleRoot(leaves: string[]): string {
  return buildMerkleTree(leaves).root;
}

export interface ProofStep {
  sibling: string;
  isRight: boolean; // true = sibling is on the right of the current node
}

/** Merkle proof (audit path) for the leaf at `index`. */
export function merkleProof(leaves: string[], index: number): ProofStep[] {
  if (index < 0 || index >= leaves.length) throw new Error(`leaf index out of range: ${index}`);
  const tree = buildMerkleTree(leaves);
  const proof: ProofStep[] = [];
  let idx = index;
  for (let layer = 0; layer < tree.layers.length - 1; layer++) {
    const nodes = tree.layers[layer];
    const isRightNode = idx % 2 === 1;
    const siblingIdx = isRightNode ? idx - 1 : idx + 1;
    const sibling = siblingIdx < nodes.length ? nodes[siblingIdx] : nodes[idx]; // odd → self
    proof.push({ sibling, isRight: !isRightNode });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Fold a leaf + proof back to a root. */
export function foldProof(leaf: string, proof: ProofStep[]): string {
  let acc = leaf;
  for (const step of proof) {
    acc = step.isRight ? hashPair(acc, step.sibling) : hashPair(step.sibling, acc);
  }
  return acc;
}

export function verifyProof(leaf: string, proof: ProofStep[], root: string): boolean {
  return foldProof(leaf, proof) === root;
}
