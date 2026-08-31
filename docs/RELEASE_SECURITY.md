# Release security model

## Trust boundaries

- Pull requests and ordinary branch pushes are untrusted validation inputs. CI has `contents: read`, receives no production secrets, and cannot publish.
- A matching repository tag is necessary but not sufficient to publish. Mutating jobs also require approval through the GitHub `production` environment.
- Browser-store credentials exist only as `production` environment secrets and are injected into one store-specific job each.
- Verified ZIPs cross job boundaries through a seven-day GitHub Actions artifact. Store jobs do not rebuild or substitute packages.
- Each publishing script requires GitHub Actions, an exact tag ref, and tag/package version equality before reading credentials or making requests.

## Artifact controls

The package builder uses a local ZIP writer with fixed timestamps, permissions,
entry order and compression settings. Verification performs two clean package
runs and compares SHA256 hashes. It also rejects path traversal, absolute paths,
backslashes, source maps, credential-like files, development metadata and any
archive that does not contain exactly one root `manifest.json`.

The extension archive contains only packaged files copied from `src/`; it never
contains `store/`, `docs/`, npm metadata, workflow files or release scripts.

## Credential controls

- No store secret is accepted from a pull request, artifact, command argument or repository file.
- API clients use fixed HTTPS origins and never follow an operation URL with credentials; only validated operation IDs are appended to fixed origins.
- HTTP errors report status and service messages without printing request headers, JWTs, private keys or API keys.
- Service credentials should be dedicated to this repository, least-privileged where the provider permits, reviewed periodically and rotated before expiry.

## Residual risk

Store APIs, account policy, listing state and credential permissions cannot be
fully tested without performing real submissions. Those paths remain **NOT YET
VERIFIED** until the first approved production release. GitHub environment
reviewers must compare the tag commit, local dry-run result and intended version
before approving any publishing job.
