# Security Policy

## Supported Versions
| Version | Supported |
|---|---|
| latest (`main`) | ✅ |

## Reporting a Vulnerability
Please **do not** open a public issue for security vulnerabilities — this
service handles x402 payment authorizations (EIP-3009 signatures) and OKX
Developer Portal credentials, so please report privately:

- Email **edy.cu@live.com**, or
- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (Security → Report a vulnerability).

You'll get an acknowledgment within 48 hours and a resolution timeline after
triage. Please give us a reasonable window to patch before public disclosure.

## Notes on this project's payment surface
- `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` are Developer Portal
  facilitator credentials — never commit real values; `.env.example` only
  ships placeholders.
- `PAYTO_ADDRESS` is a public receive address, safe to share.
- `api/rails/localFacilitator.ts` performs real EIP-3009 signature recovery
  (via `viem`) but never fabricates on-chain settlement — if you find a way to
  make it report a fake `success: true`, that is a vulnerability, please
  report it privately.
