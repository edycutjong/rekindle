# Convenience targets; npm scripts in package.json are the source of truth.
.PHONY: help check ci e2e e2e-live lighthouse security-scan

help:
	@echo "make check          typecheck + lint + tests + seed/docs/kitchen checks (no keys)"
	@echo "make ci             prod-dependency audit + check + coverage"
	@echo "make e2e            Playwright against a local keyless next start (run npm run build first)"
	@echo "make e2e-live       Playwright against https://rekindle.edycu.dev, live Qloo calls"
	@echo "make lighthouse     Lighthouse CI on /, /judge, /cases/new (run npm run build first)"
	@echo "make security-scan  prod npm audit + license allowlist + gitleaks over full history (all blocking)"

check:
	npm run check

ci:
	npm run ci

e2e:
	@echo "Playwright E2E (keyless local server)..."
	npx playwright test

e2e-live:
	npm run e2e:live

lighthouse:
	@echo "Lighthouse CI audit..."
	npm run lighthouse

security-scan:
	@echo "=== NPM AUDIT (production deps, blocking) ==="
	npm audit --omit=dev --audit-level=high
	@echo "=== NPM AUDIT (all deps, advisory) ==="
	-npm audit --audit-level=high
	@echo "=== LICENSE CHECK ==="
	npm run license
	@echo "=== GITLEAKS (full history) ==="
	gitleaks git --no-banner --redact .
