/**
 * api/validate.ts — business-parameter validation that runs BEFORE payment.
 *
 * ============================================================================
 * OKX.AI LISTING REQUIREMENT: VALIDATE FIRST, CHARGE SECOND
 * ============================================================================
 * OKX.AI review requires that a service "complete parameter validation before
 * returning the x402 payment pending signature information (challenge)" — a
 * buyer must never sign, and must never be deducted, for a call that was
 * always going to fail on its parameters. The sibling CLV Scout listing was
 * DELISTED for exactly this (2026-08-20) and re-listed only after adding this
 * gate; EdgeLedger shipped the identical pattern, so it gets the identical fix.
 *
 * `buildOkxPayGate()` (the SDK's `paymentMiddleware`) knows nothing about our
 * business params, so it will happily issue a challenge — and then verify and
 * settle a replay — for a request with no `fixture`. This module is the gate in
 * front of that gate:
 *
 *   cors -> json -> header shim -> [paramPreflight] -> okxPayGate -> edgeHandler
 *
 * Three cases, in the order the middleware decides them:
 *
 *  1. UNPAID + NO PARAMS AT ALL + GET  -> pass through to the pay gate, which
 *     answers with the 402 challenge. This is the marketplace reachability
 *     probe (`onchainos agent x402-check`): a param-less GET is discovery,
 *     never a purchase, and it must keep returning a well-formed
 *     PAYMENT-REQUIRED challenge or the listing reads as endpoint_unreachable.
 *
 *  2. INVALID PARAMS (paid or unpaid, any other shape) -> 400 right here.
 *     Unpaid, the challenge is never issued. Paid, the PAYMENT-SIGNATURE is
 *     never verified and never settled — so even a buyer who signed a challenge
 *     obtained from case 1 is NOT charged for an error.
 *
 *  3. VALID PARAMS -> `next()`, and the payment gate runs exactly as before.
 *
 * NOTE — "no model coverage" is NOT a parameter error. A well-formed call for a
 * fixture EdgeLedger has no fair-probability model for is a legitimate PAID
 * answer: it returns `verdict: SKIP, reason: no_model_coverage` (the honesty
 * gate). Preflight checks the SHAPE of the request, never the availability of
 * an answer.
 *
 * The schema here is the SAME object `api/routes.ts` parses with, so a request
 * can never pass preflight and then fail inside a handler already paid for.
 */
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { z } from 'zod';

/**
 * `fixture` is the only required param. `selection` + `odds` together switch the
 * handler into validate mode; everything else is optional.
 *
 * `z.coerce.number()` (not `z.number()`): a paid GET carries params in the query
 * string, where every value arrives as a string. Coercing here — and reusing the
 * parsed output in the handler — is also what makes validate mode reachable over
 * GET at all, since the handler's mode switch tests `typeof odds === 'number'`.
 */
export const edgeRequestSchema = z.object({
  fixture: z.string().trim().min(1),
  selection: z.string().trim().min(1).optional(),
  odds: z.coerce.number().gt(1).optional(),
  bankroll: z.coerce.number().positive().optional(),
  proposed_stake_pct: z.coerce.number().positive().optional(),
});

export type EdgeRequest = z.infer<typeof edgeRequestSchema>;

export const EDGE_PATH = '/api/edge';

/** Business params for a request: query string and JSON body merged, body wins. */
export function paramsOf(req: Request): Record<string, unknown> {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const body = req.body;
  const fromBody = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return { ...query, ...fromBody };
}

/** True when the caller supplied no business parameters whatsoever. */
export function hasNoParams(params: Record<string, unknown>): boolean {
  return Object.keys(params).length === 0;
}

/** True when the caller attached an x402 payment (v2 header or the v1 alias). */
export function isPaidRequest(req: Request): boolean {
  return Boolean(req.headers['payment-signature'] ?? req.headers['x-payment']);
}

/**
 * The 400 body for a bad call. OKX.AI's agent runtime derives call params from
 * the service description, so its first call may arrive incomplete — answer
 * with a copyable example it can retry with, and say plainly that nothing was
 * charged.
 */
export function paramErrorBody(details: unknown): Record<string, unknown> {
  return {
    error: 'invalid_request',
    service: 'EdgeLedger Verdict',
    payment:
      'No payment was requested and nothing was deducted — EdgeLedger validates parameters BEFORE issuing the x402 challenge. Fix the parameters and call again to receive a payment challenge.',
    note: 'missing/invalid params — required: {fixture}; add {selection, odds} for validate mode; optional: {bankroll, proposed_stake_pct}',
    required: ['fixture'],
    optional: ['selection', 'odds', 'bankroll', 'proposed_stake_pct'],
    example_request: { fixture: 'FRA-BRA', selection: 'France ML', odds: 2.1, bankroll: 1000, proposed_stake_pct: 2 },
    example_response_shape: { verdict: 'APPROVED | REJECTED | SKIP', edge_grade: 'A+…F', stake: '…', pick_hash: '…', receipts: '…' },
    known_fixtures_hint: 'POST /api/slate (free) lists fixtures with model coverage',
    details,
  };
}

/** Normalise `/api/edge/` and `/api/edge` to the same route key. */
function isPaidPath(reqPath: string): boolean {
  const trimmed = reqPath.length > 1 ? reqPath.replace(/\/+$/, '') : reqPath;
  return trimmed === EDGE_PATH;
}

/**
 * Validate business params ahead of the x402 payment gate. Mount it BEFORE
 * `buildOkxPayGate()`; paths that aren't payment-gated pass straight through.
 */
export function paramPreflight(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isPaidPath(req.path)) {
      next();
      return;
    }

    const params = paramsOf(req);

    // Case 1: the marketplace reachability probe — an unpaid, param-less GET.
    // Let the SDK answer it with the real challenge.
    if (!isPaidRequest(req) && (req.method === 'GET' || req.method === 'HEAD') && hasNoParams(params)) {
      next();
      return;
    }

    // Case 2: anything else must be a well-formed call before money moves.
    const parsed = edgeRequestSchema.safeParse(params);
    if (!parsed.success) {
      res.status(400).json(paramErrorBody(parsed.error.flatten()));
      return;
    }

    // Case 3: valid — hand off to the payment gate.
    next();
  };
}
