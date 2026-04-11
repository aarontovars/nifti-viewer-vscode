# `/viewer-look` — See what's in the NIfTI Viewer

Lets Claude Code inspect the current NIfTI Viewer panel and analyse what you're looking at — with zero manual steps from you.

## What happens

1. Claude creates `/tmp/nifti-viewer-capture-request`
2. The extension detects it within 500 ms and writes:
   - `/tmp/nifti-viewer-screenshot.png` — current viewer canvas
   - `/tmp/nifti-viewer-state.json` — structured state (panels, position, overlays, labels, slices)
3. Claude reads both files, analyses the image, and answers your question

## Usage examples

```
/viewer-look
/viewer-look what lesions are visible at this position?
/viewer-look is the overlay well-aligned with the anatomy?
/viewer-look describe what you see in the axial panel
```

## Steps for Claude

1. Run: `touch /tmp/nifti-viewer-capture-request`
2. Wait ~600ms: `sleep 0.6`
3. Read the screenshot with the Read tool on `/tmp/nifti-viewer-screenshot.png`
4. Read the state with the Read tool on `/tmp/nifti-viewer-state.json`
5. Analyse and respond — describe what you see, answer the user's question
