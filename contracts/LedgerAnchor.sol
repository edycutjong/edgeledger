// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  LedgerAnchor
 * @notice Daily Merkle checkpoint of EdgeLedger pick hashes on X Layer (eip155:196).
 *
 * Receipts prove WHEN each pick existed (x402 payment block time < kickoff).
 * This contract proves the LEDGER DATABASE was never rewritten after the fact:
 * a nightly job Merkle-izes the day's `pick_hash`es and posts the root here,
 * write-once per day. `edgeledger-audit --all` recomputes each day's root from
 * the served ledger and diffs it against `AnchorPosted` — any post-hoc edit to
 * a settled row changes the root and is detectable by anyone.
 *
 * Proof verification is performed off-chain against the posted root (the tree
 * uses sha256 over the hex pick hashes — see engine/merkle.ts). The chain only
 * needs to hold the immutable commitment.
 */
contract LedgerAnchor {
    struct Anchor {
        bytes32 merkleRoot;
        uint32 count;      // number of picks under this root
        uint64 timestamp;  // block time the root was posted
    }

    address public owner;
    uint32 public latestDay;
    mapping(uint32 => Anchor) public anchors; // day (whole days since epoch) => anchor

    event AnchorPosted(uint32 indexed day, bytes32 merkleRoot, uint32 count);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error AlreadyAnchored(uint32 day);
    error ZeroRoot();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Commit a day's Merkle root. Write-once per day (tamper-evident).
    function postAnchor(uint32 day, bytes32 merkleRoot, uint32 count) external onlyOwner {
        if (merkleRoot == bytes32(0)) revert ZeroRoot();
        if (anchors[day].timestamp != 0) revert AlreadyAnchored(day);
        anchors[day] = Anchor(merkleRoot, count, uint64(block.timestamp));
        if (day > latestDay) latestDay = day;
        emit AnchorPosted(day, merkleRoot, count);
    }

    /// @notice Read a day's anchor.
    function getAnchor(uint32 day) external view returns (bytes32 merkleRoot, uint32 count, uint64 timestamp) {
        Anchor memory a = anchors[day];
        return (a.merkleRoot, a.count, a.timestamp);
    }

    /// @notice Has a given day been anchored?
    function isAnchored(uint32 day) external view returns (bool) {
        return anchors[day].timestamp != 0;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
