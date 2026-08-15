# Maintainer continuity and recovery

OpenStrawberry is not yet production infrastructure. Until it has more active maintainers, contributors and users should treat the project as an early-stage open-source browser foundation rather than a service with guaranteed operational support.

## Current continuity controls

The public GitHub repository is the source of truth for code, documentation, plans, and issue history. Reproducible dependency versions are committed in `package.json` and `pnpm-lock.yaml`; release artifacts are not stored in Git. Security boundaries, release prerequisites, and local development checks are recorded in [`SECURITY.md`](SECURITY.md), [`RELEASES.md`](RELEASES.md), and [`CONTRIBUTING.md`](../CONTRIBUTING.md).

| Responsibility | Recovery expectation |
|---|---|
| Source and issues | At least two trusted maintainers should have repository administration, release, and security-advisory access before the first stable installer release. |
| Signing identities | Apple Developer ID/notarization credentials and Windows Authenticode credentials must be held in an organization-controlled secrets manager with documented recovery ownership, not in a personal workstation or repository. |
| GitHub Actions | A maintainer with workflow-edit permission should own the quality and release workflows, protected-branch policy, and required status checks. |
| Release evidence | Every public installer release must retain its GitHub Release notes, `SHA256SUMS.txt`, signing/notarization evidence, and source tag. |
| Security reports | At least two people should have access to GitHub private security advisories and follow the reporting path in [`SECURITY.md`](SECURITY.md). |

## Maintainer handoff

Before transferring responsibility, the outgoing maintainer should give the incoming maintainer access to the repository, GitHub organization settings, release runner configuration, signing/notarization accounts, domain records if any, and issue/discussion moderation. The incoming maintainer should independently clone the repository and run the documented `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm check`, and `pnpm build` checks before accepting the handoff.

The baseline [`Quality` workflow](../.github/workflows/quality.yml) is intentionally limited to source verification. It must not receive signing credentials, publish artifacts, or be treated as a release authority. Those privileges belong only in a separately reviewed release workflow that runs on trusted platform runners.

## Contributor path

Potential long-term maintainers should begin through the review process in [`CONTRIBUTING.md`](../CONTRIBUTING.md), take ownership of bounded issues, participate in security and release review, and demonstrate familiarity with Electron’s process-boundary model before being granted administrative or signing access.
