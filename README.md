# NIfTI Viewer for VS Code

**The fastest way to view neuroimaging data in VS Code** — and the first viewer designed for agentic AI workflows with Claude Code.

Open `.nii` and `.nii.gz` files with a single click. Compare multiple volumes side by side with synchronized crosshairs. Overlay segmentation masks and probability maps. Build reusable templates for reproducible analysis. Let Claude Code drive everything autonomously — opening files, navigating to findings, capturing screenshots, analysing what it sees.

[**Install from VS Code Marketplace →**](https://marketplace.visualstudio.com/items?itemName=atovar.nifti-viewer-vscode)

---

## Why this viewer

Most neuroimaging viewers require you to leave your editor, open an external tool, and manually load files. This viewer lives **inside VS Code** — where your code, terminal, and AI assistant already are.

It was designed for two use cases:
1. **Research workflows** — fast visual QC of pipeline outputs without context-switching
2. **Agentic AI workflows** — Claude Code can open, navigate, and inspect the viewer fully automatically, with no manual steps from you

> **Better than NiBabel's viewer.** Faster. Keyboard-driven. Template-based. And fully AI-native.

---

## Features

### Zero-config viewing
Double-click any `.nii` or `.nii.gz` file in the VS Code Explorer. The viewer opens immediately as a custom editor — no setup, no external tools, no terminal commands.

### Multi-panel layouts with synchronized crosshairs
Display multiple volumes side by side. All panels share the same crosshair — navigate in one, all panels follow. Arrange panels in any grid layout: `[[0,1,2]]`, `[[0,1],[2,3]]`, `[[0],[1]]`.

### Overlays: masks, probability maps, label volumes
Load any NIfTI as an overlay on the base image:
- **Contour mode** — clean outlines of segmentation boundaries
- **Filled mode** — solid overlay with adjustable opacity
- **Min/Max threshold sliders** — hide voxels below or above a value (e.g. show only high-confidence predictions)
- **14+ colormaps** — gray, hot, rainbow, viridis, Reds, Greens, bwr, discrete, tab20…
- **Discrete colormap** — 20 maximally distinct colours for integer label maps; value 0 is always transparent
- **Per-panel colormaps** — different colormap per panel in the same template

### Template system
Templates are JSON files that define reproducible multi-panel layouts. Drop them in `~/.viewer/templates/` for global access, or in any folder for project-specific configs.

```json
{
  "version": 1,
  "name": "Lesion Review",
  "viewer": { "view": "axial", "alpha": 0.7 },
  "panels": [
    {
      "title": "FLAIR",
      "image": "fwup_preproc_n4.nii.gz"
    },
    {
      "title": "FLAIR + Lesions",
      "image": "fwup_preproc_n4.nii.gz",
      "overlay": "lesion_numbered.nii.gz",
      "overlayCmap": "rainbow",
      "overlayMode": "contour"
    }
  ],
  "grid": [[0, 1]],
  "findings": "lesion_numbered_clf.json"
}
```

### Auto-template generation
Right-click any folder → **NIfTI: Generate Template from Files** — auto-detects images, overlays, and masks and generates a sensible template with smart defaults. No manual JSON editing required.

### Findings panel
Set `"findings": "classification.json"` in your template to display a lesion classification sidebar. Findings are grouped by type (new / enlarging / stable / FP / FN) with summary counts. Click any finding to navigate instantly to its 3D location.

### Keyboard-driven navigation
Full keyboard control — you rarely need to reach for the mouse:

| Key | Action |
|-----|--------|
| `A` / `C` / `S` / `M` | Axial / Coronal / Sagittal / Multiplanar |
| `V` | Cycle views |
| `G` | Cycle main panel in multiplanar |
| `j` / `k` | Scroll slices |
| `+` / `-` / `0` | Zoom in / out / reset |
| `w` | Toggle overlay |
| `q` / `e` | Decrease / increase overlay opacity |
| `c` | Cycle contour mode (template / all contour / all filled) |
| `r` | Reset auto range |
| `n` / `p` | Next / previous label |
| `Tab` | Cycle active panel |
| `l` | Cycle grid layout |
| `x` | Toggle crosshairs |
| `i` | Toggle interpolation (nearest / linear) |
| `Shift+F` | Add image side by side |
| `Shift+O` | Add overlay |
| `Ctrl+Shift+C` | Copy canvas to clipboard |

---

## Claude Code Integration

This extension has a first-class integration with [Claude Code](https://claude.ai/claude-code) that goes far beyond a simple screenshot. Three slash commands turn Claude into a fully capable co-pilot for neuroimaging review. See [CLAUDE.md](CLAUDE.md) for the complete guide.

### `/viewer-look` — Ask Claude what it sees

Open any NIfTI file in VS Code, then in Claude Code:

```
/viewer-look
/viewer-look what lesions are visible at this position?
/viewer-look is the overlay well-aligned with the anatomy?
/viewer-look describe what you see in the axial and coronal panels
```

Claude automatically captures a screenshot of the viewer **and** a structured state dump (panel titles, slice positions, overlay ranges, visible labels) and analyses everything together. No manual screenshots. No copy-paste. Zero interaction required.

---

### `/create-template` — Generate a template from any folder

This is the most powerful skill. Point Claude at a folder and describe what you want:

```
/create-template /data/patient_042
/create-template /data/patient_042 — show FLAIR with lesion overlay side by side
/create-template /data/patient_042 — 2×2 grid comparing baseline and follow-up with masks
/create-template /data/patient_042 — I want to review the probability maps
```

Claude will:
1. Scan the folder for `.nii.gz` files
2. Infer each file's role from its name — anatomical images, overlays, timepoints, probability maps
3. Draft a template JSON with the right panel layout, colormaps, and grid arrangement
4. Show you the draft and let you tweak it
5. Save it to `~/.viewer/templates/` and open the viewer immediately

**The whole thing takes under 10 seconds.** No manual JSON. No looking up colormap names. No figuring out grid syntax. Claude handles it all — and the result is a reusable template you can run on any subject.

Example — Claude sees `fwup_preproc_n4.nii.gz`, `base_preproc_n4.nii.gz`, `lesion_numbered.nii.gz` and generates:

```json
{
  "name": "Baseline vs Follow-up + Lesions",
  "viewer": { "view": "axial", "alpha": 0.7 },
  "panels": [
    { "title": "Baseline", "image": "base_preproc_n4.nii.gz", "imageCmap": "gray" },
    { "title": "Follow-up", "image": "fwup_preproc_n4.nii.gz", "imageCmap": "gray" },
    { "title": "Baseline + Lesions", "image": "base_preproc_n4.nii.gz",
      "overlay": "lesion_numbered.nii.gz", "overlayCmap": "rainbow", "overlayMode": "contour" },
    { "title": "Follow-up + Lesions", "image": "fwup_preproc_n4.nii.gz",
      "overlay": "lesion_numbered.nii.gz", "overlayCmap": "rainbow", "overlayMode": "contour" }
  ],
  "grid": [[0, 1], [2, 3]]
}
```

Claude also handles edge cases automatically:
- **Fallback arrays** when filenames vary across pipeline versions: `["fwup_n4_FLAIR.nii.gz", "fwup_FLAIR.nii.gz"]`
- **Findings panel** wired up if a classification JSON exists in the folder
- **Per-panel colormaps** matched to each file type

---

### Fully agentic QC workflows

Tell Claude:
> "Open patient HOSP-042 at `/data/HOSP-042` with a lesion review layout and tell me if the segmentation looks correct"

Claude will:
1. Run `/create-template /data/HOSP-042` to generate the layout
2. Open the viewer via the URI protocol
3. Wait for the viewer to load
4. Run `/viewer-look` to capture and analyse the current state
5. Respond with findings — all without you touching anything

Or even simpler:
> "Create a template for the files in this folder and tell me what you see"

Claude figures out the rest.

---

## Getting Started

### Install

From the VS Code Extensions panel (`Ctrl+Shift+X`) — search **NIfTI Viewer** — or:

```bash
code --install-extension atovar.nifti-viewer-vscode
```

### Open a file

Double-click any `.nii` or `.nii.gz` in the Explorer.

### Open a folder with a template

Right-click a folder in the Explorer:
- **NIfTI: Open with Template** — pick from available templates
- **NIfTI: Generate Template from Files** — auto-generate a template from folder contents

---

## Template Reference

### Panel fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Display title |
| `image` | string \| string[] | NIfTI file — array = ordered fallback list |
| `imageCmap` | string | Colormap for the base image |
| `imageRange` | `[min, max]` | Display intensity range |
| `overlay` | string \| string[] | Overlay NIfTI file |
| `overlayCmap` | string | Overlay colormap |
| `overlayRange` | `[min, max]` | Overlay intensity range |
| `overlayMode` | `"filled"` \| `"contour"` | Overlay render mode for this panel |

### Viewer settings

| Field | Default | Description |
|-------|---------|-------------|
| `view` | `"multiplanar"` | Initial view |
| `zoom` | `1` | Zoom factor |
| `alpha` | `1.0` | Overlay opacity (0–1) |
| `interpolation` | `"linear"` | `"nearest"` or `"linear"` |
| `crosshairShow` | `true` | Show crosshairs |
| `crosshairColor` | `"#00ff00"` | Crosshair colour |
| `showOverlay` | `true` | Show overlays on load |
| `mainMultiView` | `"axial"` | Main panel in multiplanar |

### Fallback file arrays

If a file may have different names across pipeline versions, use an array — the first file found is used:

```json
{ "image": ["fwup_n4_FLAIR.nii.gz", "fwup_FLAIR.nii.gz"] }
```

---

## Colormaps

| Name | Best for |
|------|----------|
| `gray` | Anatomical (T1, T2, FLAIR) |
| `hot` / `hot_r` | Probability maps |
| `jet` / `rainbow` | General-purpose |
| `viridis` | Scientific data |
| `Reds` / `Greens` | Single-channel overlays |
| `bwr` | Diverging (positive/negative) |
| `discrete` | Integer label maps (20 distinct colours, 0 = transparent) |
| `tab20` | Categorical data |
| `Pastel1` | Soft categorical colours |

---

## Programmatic Control Protocol

The extension exposes a file-based API for automation:

| File | Action |
|------|--------|
| `/tmp/nifti-viewer-open.json` | Open folder with template: `{"folderPath": "/data", "templateName": "name"}` |
| `/tmp/nifti-viewer-navigate.json` | Navigate: `{"label": 3}` or `{"position": [x, y, z]}` |
| `/tmp/nifti-viewer-capture-request` | Capture screenshot → `/tmp/nifti-viewer-screenshot.png` + `state.json` |
| `/tmp/nifti-viewer-close` | Close the active panel |

URI handler:
```
vscode://atovar.nifti-viewer-vscode/open?folder=/path/to/data&template=template_name
```

---

## Building from Source

```bash
git clone https://github.com/aarontovars/nifti-viewer-vscode
cd nifti-viewer-vscode
npm install
npm run build
```

Press `F5` in VS Code to launch the Extension Development Host.

---

## License

MIT
