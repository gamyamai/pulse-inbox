
## Static Code Analysis

This repository uses **SonarQube Community Edition** for static code analysis. Analysis runs automatically on:
- **Push** to `develop`, `main`, or `master`
- **Pull Requests** (on open, update, reopen)

Results report as GitHub status checks and PR decorations (requires quality gate to pass before merge).

### Configuration

The shared reusable workflow is in `gamyamai/shared-deployment-workflows` and automatically:
- Scans code for bugs, vulnerabilities, and code smells
- Checks security hotspot reviews
- Validates test coverage (80% minimum on new code)
- Enforces code duplication limits

**SonarQube Instance:** https://sonarqube.dev.salesastra-nonprod.com (GitHub SSO, `gamyamai` org required)

### Setup

The workflow is already configured (`.github/workflows/static_code_analysis.yaml`). Ensure `SONAR_TOKEN` secret is set in GitHub repo settings:
1. Generate token from SonarQube: My Account → Security → Tokens
2. GitHub repo Settings → Secrets → New secret: `SONAR_TOKEN`
