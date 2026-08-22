/**
 * bazaar-settle.ts — the ONE real settlement that unlocks the x402 Bazaar listing.
 *
 *   BAZAAR_BUYER_PK=0x… npx tsx scripts/bazaar-settle.ts
 *   BAZAAR_BUYER_PK=0x… npx tsx scripts/bazaar-settle.ts --url https://…/api/edge
 *   npx tsx scripts/bazaar-settle.ts --dry-run     # quote + balance check only, signs nothing
 *
 * WHY THIS EXISTS
 * ---------------
 * Coinbase CDP validates an endpoint happily (25/25 preflight checks), but it
 * will not INDEX the service in the Bazaar until it has observed one successful
 * settlement through its own facilitator. Until then `index` stays `null` and
 * the listing is invisible. So the seller has to buy from themselves exactly
 * once. The money is not lost: `payTo` is our own receiver address, so the
 * round-trip returns the full amount minus Base gas (cents).
 *
 * WHAT IT DOES
 * ------------
 *   1. probes the endpoint with VALID params -> real 402 challenge
 *   2. reads accepts[0] (network / asset / amount / payTo / extra) — never
 *      hardcodes them, so a repriced or re-networked rail still works
 *   3. checks the buyer's USDC balance on Base and refuses if short
 *   4. signs a genuine EIP-3009 TransferWithAuthorization over the USDC domain
 *      taken from the challenge's `extra` ({name, version})
 *   5. replays with X-PAYMENT, prints the verdict, the PAYMENT-RESPONSE receipt
 *      and a Basescan link
 *
 * HONESTY: this never fabricates a receipt. If the buyer key is missing, funds
 * are short, or settlement fails, it says so and exits non-zero.
 *
 * SECURITY: the private key is read from the environment and is never printed,
 * logged, or written to disk. Use a throwaway wallet funded with just enough
 * USDC — it only ever signs a transfer to our own payTo address.
 */
import { createPublicClient, http, formatUnits, encodeAbiParameters, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/** EIP-3009, the `exact` scheme's transfer authorization. */
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const DEFAULT_URL = 'https://edgeledger-bazaar-production.up.railway.app/api/edge';
const DEFAULT_BODY = { fixture: 'SF: FRA vs ESP', selection: 'France ML', odds: 2.1, bankroll: 500 };

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function normalizePk(pk: string | undefined): `0x${string}` | undefined {
  if (!pk) return undefined;
  const t = pk.trim();
  const withPrefix = (t.startsWith('0x') ? t : `0x${t}`) as `0x${string}`;
  return /^0x[0-9a-fA-F]{64}$/.test(withPrefix) ? withPrefix : undefined;
}

interface Accept {
  scheme: string;
  network: string;
  asset: `0x${string}`;
  amount: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

async function main(): Promise<void> {
  const url = argVal('--url') ?? DEFAULT_URL;
  const dryRun = process.argv.includes('--dry-run');

  console.log(`\nx402 Bazaar settlement — ${url}\n${'─'.repeat(64)}`);

  // 1) quote --------------------------------------------------------------
  const probe = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(DEFAULT_BODY),
  });
  if (probe.status !== 402) {
    console.error(`✗ expected 402 from the quote probe, got ${probe.status}`);
    console.error((await probe.text()).slice(0, 400));
    process.exit(1);
  }
  const header = probe.headers.get('payment-required');
  const challenge = header
    ? (JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { accepts: Accept[] })
    : ((await probe.json()) as { accepts: Accept[] });
  const accept = challenge.accepts?.[0];
  if (!accept) {
    console.error('✗ challenge carried no accepts[] entry');
    process.exit(1);
  }

  const chainId = Number(accept.network.split(':')[1]);
  const decimals = 6; // USDC
  const human = `${formatUnits(BigInt(accept.amount), decimals)} ${accept.extra?.name ?? 'USDC'}`;
  console.log(`  quote      : ${human}`);
  console.log(`  network    : ${accept.network} (chainId ${chainId})`);
  console.log(`  asset      : ${accept.asset}`);
  console.log(`  payTo      : ${accept.payTo}`);
  console.log(`  scheme     : ${accept.scheme}`);

  // 2) buyer + balance ----------------------------------------------------
  const buyerPk = normalizePk(process.env.BAZAAR_BUYER_PK);
  if (!buyerPk) {
    console.log(`\n  buyer      : NOT CONFIGURED`);
    console.log('\n✗ Set BAZAAR_BUYER_PK to a funded Base wallet private key (0x + 64 hex).');
    console.log('  It signs one transfer, to our OWN payTo address above — use a throwaway key.');
    process.exit(dryRun ? 0 : 1);
  }
  const account = privateKeyToAccount(buyerPk);
  const rpc = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
  const client = createPublicClient({ transport: http(rpc) });
  const balance = (await client.readContract({
    address: accept.asset,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;

  console.log(`  buyer      : ${account.address}`);
  console.log(`  balance    : ${formatUnits(balance, decimals)} USDC on Base`);

  if (balance < BigInt(accept.amount)) {
    console.log(`\n✗ Insufficient USDC. Need ${human}, have ${formatUnits(balance, decimals)}.`);
    console.log('  Fund the buyer address above with USDC on Base and re-run.');
    process.exit(1);
  }
  if (dryRun) {
    console.log('\n✓ Dry run: quote read and buyer funded. Nothing signed. Drop --dry-run to settle.');
    return;
  }

  // 3) sign ---------------------------------------------------------------
  console.log('\n  Signing EIP-3009 authorization…');
  const now = Math.floor(Date.now() / 1000);
  const nonce = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account.address, BigInt(now)]),
  );
  const authorization = {
    from: account.address,
    to: accept.payTo,
    value: accept.amount,
    validAfter: String(now - 60),
    validBefore: String(now + (accept.maxTimeoutSeconds ?? 300)),
    nonce,
  };
  const signature = await account.signTypedData({
    // domain comes from the CHALLENGE, not a constant — USDC on Base is
    // {name: "USD Coin", version: "2"}, which differs from X Layer's USD₮0.
    domain: {
      name: accept.extra?.name ?? 'USD Coin',
      version: accept.extra?.version ?? '2',
      chainId,
      verifyingContract: accept.asset,
    },
    types: AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });

  const paymentPayload = Buffer.from(
    JSON.stringify({ x402Version: 2, accepted: accept, payload: { signature, authorization } }),
  ).toString('base64');

  // 4) replay -------------------------------------------------------------
  console.log('  Replaying with payment…');
  const t0 = performance.now();
  const paid = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PAYMENT': paymentPayload,
      'PAYMENT-SIGNATURE': paymentPayload,
    },
    body: JSON.stringify(DEFAULT_BODY),
  });
  const ms = Math.round(performance.now() - t0);
  const receiptHeader = paid.headers.get('payment-response') ?? paid.headers.get('x-payment-response');
  const text = await paid.text();

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  status     : ${paid.status} (${ms}ms)`);

  if (paid.status !== 200) {
    console.log(`\n✗ Settlement did NOT complete.`);
    console.log(text.slice(0, 600));
    process.exit(1);
  }

  let txHash: string | undefined;
  if (receiptHeader) {
    try {
      const receipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8')) as Record<string, unknown>;
      txHash = (receipt.transaction ?? receipt.txHash ?? receipt.tx) as string | undefined;
      console.log(`  receipt    : ${JSON.stringify(receipt).slice(0, 300)}`);
    } catch {
      console.log(`  receipt    : ${receiptHeader.slice(0, 120)} (unparsed)`);
    }
  }

  try {
    const body = JSON.parse(text) as { verdict?: string; edge_grade?: string; fixture?: string };
    console.log(`  verdict    : ${body.verdict} (grade ${body.edge_grade}) on ${body.fixture}`);
  } catch {
    console.log(`  body       : ${text.slice(0, 200)}`);
  }

  if (txHash) console.log(`  explorer   : https://basescan.org/tx/${txHash}`);

  console.log('\n✓ Settled. Now re-run the CDP validate call — `index` should stop being null');
  console.log('  and the service should appear in GET /platform/v2/x402/discovery/resources.');
}

main().catch((err) => {
  console.error('\n✗ bazaar-settle failed:', (err as Error).message);
  process.exit(1);
});
