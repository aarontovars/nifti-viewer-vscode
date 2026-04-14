# Changelog

## 0.3.6

- **Panel tracking after extension-host restart**: template panels now survive VS Code extension-host restarts. Previously, if the host restarted while a viewer was open, the extension lost its reference to the panel — capture requests would fail silently with "No NIfTI viewer is open" even though the panel was still visible. Fixed by registering a `WebviewPanelSerializer` that re-attaches tracking on restart; the viewer data is preserved unchanged.

## 0.3.5

- **Overlay threshold**: voxels with values outside [min, max] are now fully transparent (previously clamped to colormap edge instead of hidden)
- **Position sync**: loading a new image alongside existing ones starts the crosshair at the current position instead of jumping to the new image's center
- **Multiview scroll**: when cursor is in a gap between panels, scrolling now acts on the nearest panel — fixes axial scroll accidentally moving coronal in zoomed multiview

## 0.3.3

- Extension now activates on VS Code startup (`onStartupFinished`) so the file control protocol works without manually opening a NIfTI file first

## 0.3.2

- **File-based control protocol** for autonomous operation from CLI tools (Claude Code):
  - `/tmp/nifti-viewer-open.json` — open a folder with a template
  - `/tmp/nifti-viewer-navigate.json` — navigate to a label or position
  - `/tmp/nifti-viewer-capture-request` — capture screenshot (existing, now targets last opened panel)
  - `/tmp/nifti-viewer-close` — close the last opened panel (does not affect other panels)
- New `niftiViewer.openFolderWithTemplate` command for programmatic access: accepts `folderPath` and optional `templateName` arguments
- URI handler: `vscode://atovar.nifti-viewer-vscode/open?folder=/path&template=name`
- If `templateName` is omitted, falls back to interactive template picker
- **Fixed navigateToLabel**: now searches ALL overlays across all slots for the requested label, not just the current mask index. Labels in any panel can now be navigated to.
- Open/navigate/capture/close all target the most recently opened panel, leaving other panels untouched

## 0.3.1

- Per-slot overlay colormaps: each panel's overlay can have its own colormap (e.g., panel 0 = Reds, panel 1 = Greens). Previously the last `overlayCmap` in a template overrode all panels.

## 0.3.0

- Fixed binary/degenerate overlay range: masks with values [0, 1] now get range [0, 1] instead of [1, 1], so colormaps render correct colors instead of white.

## 0.2.9

- Overlay Min/Max range sliders in the Overlay menu (per active panel, same as image range sliders)
- Overlay Auto Range button (`Shift+R`) resets overlay range to [min_nonzero, max]

## 0.2.8

- Fixed overlay range computation to match notebook web viewer: uses [min_nonzero, max] instead of percentile-based range. Probabilistic overlays now show proper colormap spread.

## 0.2.7

- Updated README with Claude Code `/viewer-look` integration documentation
- Updated CHANGELOG with all versions

## 0.2.6

- Copy canvas to clipboard with `Ctrl+Shift+C` (shows toast notification)
- Capture Viewer Screenshot command (`Ctrl+Shift+P` → "NIfTI: Capture Viewer Screenshot") — saves canvas as PNG + viewer state as JSON to `/tmp/` for external tool integration
- Auto-capture support via file watcher (`/tmp/nifti-viewer-capture-request`) for CLI integration

## 0.2.5

- Reverted auto-capture on every render (wasteful). Capture is now on-demand only.
- Crosshair color reverted to lime green (#00ff00)

## 0.2.4

- Screenshot capture command: `Ctrl+Shift+P` → "NIfTI: Capture Viewer Screenshot"
- Viewer state JSON saved alongside screenshot

## 0.2.3

- Fixed CSS not loading in published extension (styles.css now bundled in dist/)
- Fixed `localResourceRoots` for webview resource loading

## 0.2.2

- Excluded `.vsce-pat` from VSIX package

## 0.2.1

- Changed publisher to `atovar`

## 0.2.0

- Per-overlay display modes: templates can specify `overlayMode` ("filled" or "contour") per panel, and the `c` key cycles through template/all-contour/all-filled states
- Discrete/label colormap with 20 maximally distinct colors for integer segmentation overlays
- Auto-template generation command: right-click a folder to scan NIfTI files and generate a sensible viewer template with smart defaults

## 0.1.0

- Initial release
- Custom editor for .nii and .nii.gz files
- Multi-panel side-by-side viewing with synchronized crosshairs
- Template-based layouts with overlay support
- Multiplanar, axial, coronal, sagittal views
- Keyboard shortcuts for navigation, view cycling, overlay toggle
- Drag-and-drop panel reordering
- Findings panel for lesion classification display
