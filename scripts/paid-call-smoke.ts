/**
 * paid-call-smoke.ts — the CREDENTIAL/FUNDS-GATED end-to-end paid call.
 *
 *   npx tsx scripts/paid-call-smoke.ts            # against a running API (npm run api)
 *   npx tsx scripts/paid-call-smoke.ts --url <u>  # against a deployed API
 *
 * Preflight (no network calls that could hang in CI):
 *   - refuses unless OKX_API_KEY/SECRET_KEY/PASSPHRASE are configured (the
 *     local-faithful facilitator in api/rails/localFacilitator.ts can verify a
 *     signature but honestly refuses to settle on-chain — see that file)
 *   - refuses unless BUYER_WALLET_PK is set and reads a non-zero USD₮0 balance
 *     on X Layer (keyless RPC read)
 * Full run (both present):
 *   - signs a real EIP-3009 `transferWithAuthorization` for $0.05 USD₮0,
 *     POSTs /api/edge with the X-PAYMENT header, and prints the
 *     PAYMENT-RESPONSE receipt + explorer link.
 *
 * This NEVER fabricates a receipt (PRODUCTION_PLAN honesty gate #1). If
 * settlement fails or credentials/funds are missing, it says so and exits
 * non-zero — it does not print a fake tx hash.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, formatUnits, getContract, encodeAbiParameters, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { authorizationTypes } from '@okxweb3/x402-evm';
import { NET, PAYTO_ADDRESS, PRICE_UNITS, HAS_REAL_OKX_CREDS, API_BASE_URL, explorerTx, PATHS } from '../config';

const ERC20_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function normalizePk(pk: string | undefined): `0x${string}` | undefined {
  if (!pk) return undefined;
  const withPrefix = pk.trim().startsWith('0x') ? pk.trim() : `0x${pk.trim()}`;
  return /^0x[0-9a-fA-F]{64}$/.test(withPrefix) ? (withPrefix as `0x${string}`) : undefined;
}

async function preflightBalance(pk: `0x${string}`): Promise<{ ready: boolean; balance: bigint; addr: `0x${string}` }> {
  const account = privateKeyToAccount(pk);
  const client = createPublicClient({ transport: http(NET.rpc) });
  let balance = 0n;
  try {
    const erc20 = getContract({ address: NET.usdt0, abi: ERC20_BALANCE_ABI, client });
    balance = (await erc20.read.balanceOf([account.address])) as bigint;
  } catch (e) {
    console.error(`  (balance read failed — RPC issue: ${(e as Error).message})`);
  }
  return { ready: balance >= BigInt(PRICE_UNITS), balance, addr: account.address };
}

async function main(): Promise<void> {
  const url = (argVal('--url') ?? API_BASE_URL) + '/api/edge';
  console.log(`paid-call-smoke → ${url}  (${NET.name})`);
  console.log(`  OKX Developer Portal credentials: ${HAS_REAL_OKX_CREDS ? 'present' : 'ABSENT'}`);

  if (!HAS_REAL_OKX_CREDS) {
    console.log('\n⛔ NOT CONFIGURED — refusing to attempt a paid call (honest: no receipt fabricated).');
    console.log('   Set OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE in build/.env.local');
    console.log('   (web3.okx.com/onchainos/dev-portal). Without them the local-faithful');
    console.log('   facilitator (api/rails/localFacilitator.ts) can verify a signature but');
    console.log('   will never settle on-chain — see that file header.');
    process.exit(3);
  }

  const buyerPk = normalizePk(process.env.BUYER_WALLET_PK);
  if (!buyerPk) {
    console.log('\n⛔ BUYER_WALLET_PK not set. See build/.env.local.');
    process.exit(3);
  }

  const pf = await preflightBalance(buyerPk);
  console.log(`  buyer   : ${pf.addr}`);
  console.log(`  USD₮0   : ${formatUnits(pf.balance, 6)} (need >= ${formatUnits(BigInt(PRICE_UNITS), 6)})`);

  if (!pf.ready) {
    console.log('\n⛔ NOT FUNDED — skipping the real payment (honest: no receipt fabricated).');
    console.log(`   Fund ${pf.addr} with >= $0.05 USD₮0 on X Layer (okx.com/xlayer/faucet for rehearsal).`);
    process.exit(3);
  }

  console.log('\n✓ Configured + funded. Signing + sending real paid call…');
  const account = privateKeyToAccount(buyerPk);
  const now = Math.floor(Date.now() / 1000);
  const nonce = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account.address, BigInt(now)]));
  const authorization = {
    from: account.address,
    to: PAYTO_ADDRESS,
    value: PRICE_UNITS,
    validAfter: String(now - 60),
    validBefore: String(now + 120),
    nonce,
  };
  const signature = await account.signTypedData({
    domain: { name: 'USD₮0', version: '1', chainId: NET.chainId, verifyingContract: NET.usdt0 },
    types: authorizationTypes,
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

  const xPayment = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: 'exact', network: NET.caip2, asset: NET.usdt0, amount: PRICE_UNITS, payTo: PAYTO_ADDRESS },
    payload: { signature, authorization },
  })).toString('base64');

  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': xPayment },
    body: JSON.stringify({ fixture: 'SF: FRA vs ESP', selection: 'France to advance', odds: 2.05, bankroll: 500 }),
  });
  const dt = performance.now() - t0;
  console.log(`← HTTP ${res.status} in ${dt.toFixed(0)}ms`);

  const paymentResponseHeader = res.headers.get('payment-response');
  if (res.status === 200 && paymentResponseHeader) {
    const receipt = JSON.parse(Buffer.from(paymentResponseHeader, 'base64').toString('utf8'));
    if (receipt.success && receipt.transaction) {
      console.log(`  ✓ receipt tx : ${receipt.transaction}`);
      console.log(`  explorer     : ${explorerTx(receipt.transaction)}`);
      if (fs.existsSync(PATHS.bench())) {
        const b = JSON.parse(fs.readFileSync(PATHS.bench(), 'utf8'));
        b.total_paid_ms = Math.round(dt);
        b.first_paid_receipt = { tx: receipt.transaction, at: new Date().toISOString() };
        fs.writeFileSync(PATHS.bench(), JSON.stringify(b, null, 2));
      }
      console.log('\n  verdict:', JSON.stringify(await res.json().catch(() => ({})), null, 2));
      return;
    }
  }
  console.error('  ✗ settlement did not succeed (no fabricated receipt).');
  console.error('   body:', await res.text().catch(() => '(unreadable)'));
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
