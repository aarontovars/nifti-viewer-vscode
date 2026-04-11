# Claude Code Integration

This extension integrates deeply with [Claude Code](https://claude.ai/claude-code). The `.claude/commands/` folder contains slash commands that give Claude Code superpowers when working with this viewer — no manual screenshots, no copy-paste, fully automated.

## Installing the skills

Claude Code picks up project-level commands automatically when you open this folder. No extra setup — the commands are active the moment you open the project in Claude Code.

### Available commands

| Command | Description |
|---------|-------------|
| `/viewer-look` | Claude inspects the current viewer and analyses what you see |
| `/create-template` | Claude scans a folder, generates a template JSON, saves it and opens the viewer |
| `/publish` | Step-by-step guide to publish the extension to the VS Code Marketplace |

---

## `/viewer-look` — Inspect the viewer

Open a NIfTI file in VS Code, then in Claude Code type:

```
/viewer-look
```

Claude will automatically capture a screenshot of the viewer and tell you what it sees. You can ask specific questions:

```
/viewer-look how many lesions are visible in this slice?
/viewer-look is the segmentation mask well-aligned with the anatomy?
/viewer-look what structures are visible in the coronal panel?
```

No manual screenshots. No copy-paste. Fully automated.

---

## `/create-template` — Generate a template from a folder

Point Claude at any folder containing NIfTI files:

```
/create-template /data/patient_042
/create-template /data/patient_042 — show FLAIR with lesion overlay side by side
/create-template /data/patient_042 — 2x2 grid comparing two timepoints with masks
```

Claude will:
1. Scan the folder for `.nii.gz` files
2. Infer each file's role (anatomical, overlay, timepoint) from its name
3. Draft a template JSON with sensible panel layout, colormaps, and grid
4. Show you the draft and ask for changes
5. Save it to `~/.viewer/templates/` and open the viewer

**The whole thing takes about 10 seconds.** No manual JSON editing. No looking up colormap names. Claude handles it all.

---

## Agentic workflows

Claude Code can drive the viewer programmatically via the file-based control protocol:

| File | Action |
|------|--------|
| `/tmp/nifti-viewer-open.json` | Open a folder: `{"folderPath": "/data/patient", "templateName": "lesion_review"}` |
| `/tmp/nifti-viewer-navigate.json` | Navigate: `{"label": 3}` or `{"position": [120, 95, 48]}` |
| `/tmp/nifti-viewer-capture-request` | Trigger screenshot → writes `screenshot.png` + `state.json` to `/tmp/` |
| `/tmp/nifti-viewer-close` | Close the active panel |

URI handler for opening from any CLI tool:
```
vscode://atovar.nifti-viewer-vscode/open?folder=/path/to/data&template=template_name
```

### Example: fully automated QC workflow

Ask Claude:
> "Open the patient data at `/data/patient_042` with the lesion review template and tell me what you see"

Claude will:
1. Create the open request file with the folder path and template
2. Wait for the viewer to load
3. Trigger a screenshot capture
4. Read the PNG and state JSON
5. Describe the findings — all without you touching anything

Claude can also **create templates** on the fly. Describe what you want to see, and Claude generates the JSON template, saves it to `~/.viewer/templates/`, and opens the viewer with it.
