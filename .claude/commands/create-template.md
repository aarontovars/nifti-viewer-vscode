# `/create-template` — Generate a NIfTI viewer template

Scans a folder for NIfTI files and generates a ready-to-use viewer template based on what you want to see. Saves it to `~/.viewer/templates/` and opens the viewer automatically.

## Usage examples

```
/create-template /data/patient_042
/create-template /data/patient_042 — show FLAIR with lesion overlay side by side
/create-template /data/patient_042 — 2x2 grid: base, followup, base+mask, followup+mask
/create-template /data/patient_042 — I want to compare the two timepoints
```

## Steps for Claude

### 1. Scan the folder for NIfTI files
```bash
ls /path/to/folder/*.nii.gz 2>/dev/null || find /path/to/folder -name "*.nii.gz" -maxdepth 2
```

List all `.nii.gz` files. Note their names — use the filenames to infer their roles:
- Files with `preproc`, `n4`, `flair`, `t1`, `t2` → base anatomical images
- Files with `lesion`, `mask`, `seg`, `label`, `prob` → overlays/segmentations
- Files with `base`, `fwup`, `followup`, `fu` → timepoints

### 2. Understand the user's intent
If the user described what they want, use that. Otherwise, apply these sensible defaults:
- 1 image file → single panel, axial view
- 1 image + 1 mask → 2 panels: image alone | image + mask overlay
- 2 timepoints → 2 panels side by side with synchronized crosshairs
- 2 timepoints + masks → 4 panels in a 2×2 grid

### 3. Draft the template JSON
Use this schema:

```json
{
  "version": 1,
  "name": "descriptive name based on folder or user intent",
  "description": "one-line description",
  "viewer": {
    "view": "axial",
    "alpha": 0.7,
    "showOverlay": true
  },
  "panels": [
    {
      "title": "human-readable title",
      "image": "filename.nii.gz",
      "imageCmap": "gray"
    },
    {
      "title": "image + overlay title",
      "image": "filename.nii.gz",
      "overlay": "mask.nii.gz",
      "overlayCmap": "rainbow",
      "overlayMode": "contour"
    }
  ],
  "grid": [[0, 1]]
}
```

**Colormap guidance:**
- Anatomical images → `"gray"`
- Probability maps → `"hot"`
- Integer label / segmentation masks → `"discrete"` or `"rainbow"`
- Side-by-side comparison → same colormap both panels for consistency

**Grid guidance:**
- 2 panels → `[[0, 1]]`
- 4 panels 2×2 → `[[0, 1], [2, 3]]`
- 3 panels, wide main + 2 small → `[[0, 1, 2]]` or discuss with user

**Overlay mode guidance:**
- Segmentation masks → `"contour"` (shows boundaries cleanly)
- Probability maps → `"filled"` (solid colour showing magnitude)

### 4. Show the draft to the user
Print the JSON and explain your choices. Ask for any changes before saving.

### 5. Save the template
```bash
mkdir -p ~/.viewer/templates
cat > ~/.viewer/templates/<name>.json << 'EOF'
<template json>
EOF
echo "Saved to ~/.viewer/templates/<name>.json"
```

Use a filename derived from the template name (lowercase, underscores, no spaces).

### 6. Open the viewer (optional)
If VS Code is open and the extension is active, open the folder with the template via the URI:
```bash
open "vscode://atovar.nifti-viewer-vscode/open?folder=<encoded_folder_path>&template=<template_name>"
```

Or instruct the user: *"Run **NIfTI: Open with Template** in VS Code and select `<name>`."*

## Tips for good templates

- Keep panel titles short — they appear in the viewer header
- For follow-up studies, name panels after the timepoint: `"Baseline"`, `"6 months"`, `"12 months"`
- If files might have different names across subjects, use a fallback array:
  ```json
  { "image": ["fwup_n4_FLAIR.nii.gz", "fwup_preproc.nii.gz", "fwup.nii.gz"] }
  ```
- Add `"findings": "classification.json"` if a findings file exists in the folder
