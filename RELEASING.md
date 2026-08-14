# Releasing to npm

The package is published publicly as `@multica-ai/dsh-runtime`. The source
repository may remain private, but every file listed by `npm pack` becomes
public when the package is published.

## Preconditions

- Work from a clean `main` branch synchronized with `origin/main`.
- Confirm the version in `package.json` has never been published.
- Confirm `UNLICENSED` is still the intended license policy for the release.
- Log in to npm with an account allowed to publish public packages under the
  `@multica-ai` scope.
- Do not place API keys, MCP credentials, session logs, `.env` files, or local
  DSH profiles in the package.

## Build and inspect

```bash
pnpm install --frozen-lockfile
pnpm release:check
```

`release:check` runs type checking, tests, a clean TypeScript build, and an npm
pack dry run. Inspect the printed file list and package size before continuing.

Create the exact artifact that will be tested and published:

```bash
pnpm pack --pack-destination /absolute/path/to/release-artifacts
```

Install that tarball into an empty DSH profile and verify at least:

```bash
dsh plugin --profile multica-release-test add /absolute/path/to/package.tgz
dsh --profile multica-release-test --probe
dsh --profile multica-release-test --list-models
```

The release candidate should also pass the opt-in Multica real-runtime smoke,
including a first turn and session resume, using credentials supplied only in
the test process environment.

## Publish

After the artifact and clean-install checks pass:

```bash
npm whoami
npm publish
```

`publishConfig.access` makes the scoped package public. `prepublishOnly` reruns
the full check before npm accepts the package.

Verify the registry result before creating a Git tag or GitHub release:

```bash
npm view @multica-ai/dsh-runtime version dist-tags --json
dsh plugin --profile multica-registry-test add @multica-ai/dsh-runtime@0.1.0
dsh --profile multica-registry-test --probe
```

Only after registry installation succeeds should the matching `v0.1.0` Git
tag and GitHub release be created.
