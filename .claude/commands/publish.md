# `/publish` — Publish NIfTI Viewer to VS Code Marketplace

Publish the extension to the VS Code Marketplace.

## Pre-flight checklist

1. **Update CHANGELOG.md** — add a new section at the top with the version number and a bullet list of ALL changes since the last release. This is mandatory.
2. **Bump version** in `package.json` (patch for fixes, minor for new features)
3. **Build**: `npm run build`
4. **Verify** `dist/` contains: `extension.js`, `webview.js`, `styles.css`, `parseWorker.js`
5. **Ask the user for approval** — show them the version number and changelog entry. Never publish without an explicit "go" from the user.

## Publish

```bash
npx @vscode/vsce publish --pat "YOUR_PAT_HERE" --no-dependencies
```

Get a Personal Access Token from https://dev.azure.com:
- Create a token under your organisation
- Scope: **Marketplace → Manage**

## After publishing

Verify at: https://marketplace.visualstudio.com/items?itemName=atovar.nifti-viewer-vscode

## Rules

- Always update CHANGELOG before publishing — every change must be documented
- Always ask the user before publishing — never do it autonomously
- Always bump version (marketplace rejects duplicate versions)
- Use `--no-dependencies` (all deps are bundled by esbuild)
