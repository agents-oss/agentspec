# Publishing to npm

This guide explains how to publish AgentSpec packages to npm under `@agentspec`.

---

## Authentication: OIDC Trusted Publishing (no NPM_TOKEN)

We use **npm Trusted Publishing** via GitHub Actions OIDC — no static token secrets needed.

### Benefits

- **No secrets to manage** — uses GitHub's short-lived OIDC tokens
- **Cannot leak** — tokens expire immediately after each workflow run
- **Automatic provenance** — npm links packages to source commit
- **Follows modern security best practices**

### First-time Setup (one-time only)

You must publish each package once manually to claim the package name, then configure Trusted Publishing on npm.org.

**Step 1 — Publish manually to claim the package names:**

```bash
npm login       # requires 2FA

cd packages/sdk
npm publish --access public

cd ../adapter-langgraph
npm publish --access public

cd ../cli
npm publish --access public
```

**Step 2 — Configure Trusted Publishing on npm.org:**

For each package (`@agentspec/sdk`, `@agentspec/adapter-langgraph`, `@agentspec/cli`):

1. Go to `https://www.npmjs.com/package/@agentspec/PACKAGE_NAME/access`
2. Under **"GitHub Actions"**, add the repository:
   - Repository: `agents-oss/agentspec`
   - Workflow: `publish.yml`
3. Click **"Add"**

After this, all future releases are fully automated — no NPM_TOKEN secret required.

---

## Automated Publishing (standard flow)

### Step 1 — Bump versions in all packages

```bash
# Patch (0.1.0 → 0.1.1)
pnpm version patch --recursive

# Minor (0.1.0 → 0.2.0)
pnpm version minor --recursive

# Major (1.0.0)
pnpm version major --recursive
```

### Step 2 — Update CHANGELOG.md

```bash
# Document changes under the new version section
## [0.2.0] - 2026-02-27

### Added
- @agentspec/adapter-crewai package

### Fixed
- Resolver bug with nested $secret: refs
```

### Step 3 — Commit and tag

```bash
git add packages/sdk/package.json packages/cli/package.json packages/adapter-langgraph/package.json CHANGELOG.md
git commit -m "chore: bump version to 0.2.0"

git tag v0.2.0
git push origin main
git push origin v0.2.0
```

### Step 4 — Monitor

Go to **Actions → Publish to npm** in the GitHub repo. The workflow will:

1. Build all packages
2. Run all tests
3. Publish each package to npm with provenance
4. Create a GitHub Release

---

## Manual Trigger (workflow_dispatch)

If a tag-based publish fails partway, you can re-trigger manually:

1. **Actions → Publish to npm → Run workflow**
2. Enter version (e.g., `0.2.0`)
3. Click **Run workflow**

---

## Verify Publication

```bash
npm view @agentspec/sdk
npm view @agentspec/adapter-langgraph
npm view @agentspec/cli

# Test installation
npx @agentspec/cli@latest validate examples/budgetbud/agent.yaml
```

---

## Troubleshooting

### "You do not have permission to publish"

1. Confirm you completed the first-time manual publish above
2. Confirm Trusted Publishing is configured on npm.org for the package
3. Confirm `id-token: write` permission is set in `publish.yml` (already done)

### "Version already exists"

```bash
# Check what's published
npm view @agentspec/sdk version

# Bump again and retag
pnpm version patch --recursive
git add -A && git commit -m "chore: bump version"
git tag v0.1.1
git push origin main --tags
```

### "workspace:* in published package.json"

This means `npm publish` was used instead of `pnpm publish`. The workflow uses
`pnpm publish` intentionally — pnpm replaces `workspace:*` with the real version
number before uploading the tarball. Do not change `pnpm publish` to `npm publish`.

### Local CI check before tagging

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```
