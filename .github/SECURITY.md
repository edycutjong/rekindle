# Security Policy

## Supported versions
| Version | Supported |
|---|---|
| latest (`main`, deployed at https://rekindle-one.vercel.app) | ✅ |

## Reporting a vulnerability
Please **do not** open a public issue. Report privately:

- GitHub [private vulnerability reporting](https://github.com/edycutjong/rekindle/security/advisories/new) (Security → Report a vulnerability), or
- email **edy.cu@live.com**.

You will get an acknowledgment within 48 hours and a timeline after triage.

## What the app protects, and the tests behind it
- **No keys in the browser or the repo.** Qloo and LLM keys are server-side env vars; `/integrations/qloo` shows request parameters without the key. gitleaks scans the full git history on every push (`.github/workflows/gitleaks.yml`); GitHub secret scanning with push protection is on.
- **Write access to a plan is its creator's.** Other visitors are read-only (403) and can copy the case (`tests/gate.test.ts`, "plans have owners").
- **Quotas are separated.** Public, judge and bench requests have their own rate limits; a wrong or short judge/bench token is treated as public (`tests/ratelimit.test.ts`).
- **No health data is sent to Qloo by design.** Intake love text is screened for clinical words and contact data before any request (`screenLoveText`; a narrow deny list, not a guarantee).
- **Dependencies.** CodeQL (TypeScript + Python), Dependabot alerts and security updates, and `npm audit` on production dependencies in CI.
