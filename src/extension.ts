import * as vscode from "vscode";
import { NiftiEditorProvider } from "./niftiEditorProvider";
import { getWebviewHtml } from "./webviewHtml";
import {
  discoverTemplates,
  parseTemplate,
  validateTemplateFiles,
  folderContainsNifti,
} from "./templateProvider";

/** Encode Uint8Array to base64 efficiently */
function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return Buffer.from(binary, "binary").toString("base64");
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(NiftiEditorProvider.register(context));

  // ── Auto-capture file watcher ──────────────────────────────────
  // Watches for /tmp/nifti-viewer-capture-request — when it appears,
  // captures screenshot from active viewer and saves to /tmp/
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const tmpDir = os.tmpdir();
  const capturePath = path.join(tmpDir, "nifti-viewer-capture-request");
  const screenshotPath = path.join(tmpDir, "nifti-viewer-screenshot.png");
  const statePath = path.join(tmpDir, "nifti-viewer-state.json");
  const openPath = path.join(tmpDir, "nifti-viewer-open.json");
  const navigatePath = path.join(tmpDir, "nifti-viewer-navigate.json");
  const closePath = path.join(tmpDir, "nifti-viewer-close");

  // Track the most recently opened panel for targeted control
  let lastOpenedPanel: vscode.WebviewPanel | null = null;

  const getTargetPanel = (): vscode.WebviewPanel | null => {
    // Prefer last opened, fall back to any active panel
    if (lastOpenedPanel) return lastOpenedPanel;
    const allPanels = new Set([...activePanels, ...NiftiEditorProvider.activePanels]);
    for (const p of allPanels) return p;
    return null;
  };

  const checkControlFiles = () => {
    try {
      // Capture request — target last opened panel only
      if (fs.existsSync(capturePath)) {
        fs.unlinkSync(capturePath);
        const panel = getTargetPanel();
        if (panel) {
          panel.webview.postMessage({ type: "capture-state" });
        } else {
          fs.writeFileSync(statePath, JSON.stringify({ error: "No NIfTI viewer is open" }));
        }
      }

      // Open request: {"folder": "/path", "template": "name"}
      // Opens a new panel (does NOT close existing ones)
      if (fs.existsSync(openPath)) {
        const data = JSON.parse(fs.readFileSync(openPath, "utf-8"));
        fs.unlinkSync(openPath);
        if (data.folder) {
          vscode.commands.executeCommand(
            "niftiViewer.openFolderWithTemplate",
            data.folder,
            data.template || undefined
          );
        }
      }

      // Navigate request: {"label": 5} or {"position": [x, y, z]}
      // Target last opened panel only
      if (fs.existsSync(navigatePath)) {
        const data = JSON.parse(fs.readFileSync(navigatePath, "utf-8"));
        fs.unlinkSync(navigatePath);
        const panel = getTargetPanel();
        if (panel) {
          if (data.label !== undefined) {
            panel.webview.postMessage({ type: "navigate-label", label: data.label });
          } else if (data.position) {
            panel.webview.postMessage({ type: "navigate-position", position: data.position });
          }
        }
      }

      // Close request — close the last opened panel only
      if (fs.existsSync(closePath)) {
        fs.unlinkSync(closePath);
        if (lastOpenedPanel) {
          lastOpenedPanel.dispose();
          lastOpenedPanel = null;
        }
      }
    } catch { /* ignore */ }
  };

  // Poll every 500ms
  const controlInterval = setInterval(checkControlFiles, 500);
  context.subscriptions.push({ dispose: () => clearInterval(controlInterval) });

  // ── Serializer: re-track template panels after extension-host restart ──
  // With retainContextWhenHidden:true the webview JS survives a restart and
  // still holds its NIfTI data.  We only need to re-register tracking so
  // getTargetPanel() can find the panel again.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("niftiViewer.template", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown) {
        activePanels.add(panel);
        lastOpenedPanel = panel;
        panel.onDidDispose(() => {
          activePanels.delete(panel);
          if (lastOpenedPanel === panel) lastOpenedPanel = null;
        });
        // Re-attach capture handler — the webview is already live with data
        panel.webview.onDidReceiveMessage(async (msg) => {
          if (msg.type === "capture-state-response") {
            const b64 = (msg.screenshotBase64 as string).replace(/^data:image\/png;base64,/, "");
            fs.writeFileSync(screenshotPath, Buffer.from(b64, "base64"));
            fs.writeFileSync(statePath, JSON.stringify(msg.state, null, 2));
            vscode.window.showInformationMessage(`Screenshot saved to ${screenshotPath}`);
          }
        });
      },
    })
  );

  // ── Generate Template command ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "niftiViewer.generateTemplate",
      async (folderUri?: vscode.Uri) => {
        if (!folderUri) {
          const uris = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            title: "Select folder to generate template from",
          });
          if (!uris || uris.length === 0) return;
          folderUri = uris[0];
        }

        if (!(await folderContainsNifti(folderUri))) {
          vscode.window.showErrorMessage("No NIfTI files found in the selected folder.");
          return;
        }

        try {
          const template = await generateTemplateFromFolder(folderUri);
          const templateDir = vscode.Uri.joinPath(folderUri, ".viewer", "templates");
          await vscode.workspace.fs.createDirectory(templateDir);
          const templateUri = vscode.Uri.joinPath(templateDir, "auto_generated.json");
          const content = Buffer.from(JSON.stringify(template, null, 2), "utf-8");
          await vscode.workspace.fs.writeFile(templateUri, content);

          vscode.window.showInformationMessage(
            `Template generated: ${templateUri.fsPath}`
          );

          // Open viewer with the generated template
          openTemplatePanel(template, folderUri!, template.name);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to generate template: ${err.message}`);
        }
      }
    )
  );

  // ── Helper: open a webview panel with a parsed template ────────
  const openTemplatePanel = (
    template: import("./templateProvider").ViewerTemplate,
    folderUri: vscode.Uri,
    title: string
  ) => {
    const panel = vscode.window.createWebviewPanel(
      "niftiViewer.template",
      title,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist"), vscode.Uri.joinPath(context.extensionUri, "src")] }
    );

    activePanels.add(panel);
    lastOpenedPanel = panel;
    panel.onDidDispose(() => {
      activePanels.delete(panel);
      if (lastOpenedPanel === panel) lastOpenedPanel = null;
    });

    panel.webview.html = getWebviewHtml(
      panel.webview,
      context.extensionUri,
      title
    );

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "ready") {
        try {
          await sendTemplateData(panel, template, folderUri);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to load template: ${err.message}`);
        }
      }
      if (msg.type === "capture-state-response") {
        const fs = require("fs");
        const path = require("path");
        const screenshotPath = path.join(require("os").tmpdir(), "nifti-viewer-screenshot.png");
        const statePath = path.join(require("os").tmpdir(), "nifti-viewer-state.json");
        const b64 = msg.screenshotBase64.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(screenshotPath, Buffer.from(b64, "base64"));
        fs.writeFileSync(statePath, JSON.stringify(msg.state, null, 2));
        vscode.window.showInformationMessage(`Screenshot saved to ${screenshotPath}`);
      }
    });

    return panel;
  };

  // ── Helper: discover, pick/find template, validate, and open ──
  const resolveAndOpenTemplate = async (
    folderUri: vscode.Uri,
    templateName?: string
  ): Promise<void> => {
    if (!(await folderContainsNifti(folderUri))) {
      vscode.window.showErrorMessage("No NIfTI files found in the selected folder.");
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const templates = await discoverTemplates(workspaceFolder, folderUri);
    if (templates.length === 0) {
      vscode.window.showErrorMessage(
        "No templates found. Create templates in .viewer/templates/ (project) or ~/.viewer/templates/ (global)."
      );
      return;
    }

    let picked: { name: string; uri: vscode.Uri } | undefined;

    if (templateName) {
      // Programmatic: find template by name (case-insensitive)
      picked = templates.find(
        (t) => t.name.toLowerCase() === templateName.toLowerCase()
      );
      if (!picked) {
        vscode.window.showErrorMessage(
          `Template "${templateName}" not found. Available: ${templates.map((t) => t.name).join(", ")}`
        );
        return;
      }
    } else {
      // Interactive: show quick pick
      const selection = await vscode.window.showQuickPick(
        templates.map((t) => ({ label: t.name, uri: t.uri })),
        { placeHolder: "Select a viewer template" }
      );
      if (!selection) return;
      picked = { name: selection.label, uri: selection.uri };
    }

    let template;
    try {
      template = await parseTemplate(picked.uri);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Invalid template: ${err.message}`);
      return;
    }

    const validation = await validateTemplateFiles(template, folderUri);
    if (!validation.valid) {
      vscode.window.showErrorMessage(
        `Missing files in folder: ${validation.missing.join(", ")}`
      );
      return;
    }

    openTemplatePanel(template, folderUri, template.name || picked.name);
  };

  // ── Apply Template command ─────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "niftiViewer.applyTemplate",
      async (folderUri?: vscode.Uri) => {
        if (!folderUri) {
          const uris = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            title: "Select folder to apply template to",
          });
          if (!uris || uris.length === 0) return;
          folderUri = uris[0];
        }
        await resolveAndOpenTemplate(folderUri);
      }
    )
  );

  // ── Open Folder With Template command (programmatic) ──────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "niftiViewer.openFolderWithTemplate",
      async (folderPath?: string, templateName?: string) => {
        if (!folderPath) {
          // Fall back to folder picker if no path provided
          const uris = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            title: "Select folder containing NIfTI files",
          });
          if (!uris || uris.length === 0) return;
          await resolveAndOpenTemplate(uris[0], templateName);
          return;
        }

        const folderUri = vscode.Uri.file(folderPath);
        await resolveAndOpenTemplate(folderUri, templateName);
      }
    )
  );

  // ── URI handler: vscode://atovar.nifti-viewer-vscode/open?folder=...&template=... ──
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === "/open") {
          const params = new URLSearchParams(uri.query);
          const folder = params.get("folder");
          const template = params.get("template") || undefined;
          if (!folder) {
            vscode.window.showErrorMessage(
              "URI handler: missing 'folder' parameter. Usage: vscode://atovar.nifti-viewer-vscode/open?folder=/path&template=name"
            );
            return;
          }
          vscode.commands.executeCommand(
            "niftiViewer.openFolderWithTemplate",
            folder,
            template
          );
        }
      },
    })
  );

  // ── Capture State command ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("niftiViewer.captureState", () => {
      // Broadcast to all tracked panels (template panels + custom editor panels)
      const allPanels = new Set([...activePanels, ...NiftiEditorProvider.activePanels]);
      for (const panel of allPanels) {
        panel.webview.postMessage({ type: "capture-state" });
      }
      if (allPanels.size === 0) {
        vscode.window.showWarningMessage("No NIfTI viewer is open");
      }
    })
  );
}

// Track active webview panels for capture command
const activePanels = new Set<vscode.WebviewPanel>();

async function generateTemplateFromFolder(
  folderUri: vscode.Uri
): Promise<import("./templateProvider").ViewerTemplate> {
  const entries = await vscode.workspace.fs.readDirectory(folderUri);
  const niftiFiles = entries
    .filter(
      ([name, type]) =>
        type === vscode.FileType.File &&
        (name.endsWith(".nii") || name.endsWith(".nii.gz"))
    )
    .map(([name]) => name);

  if (niftiFiles.length === 0) {
    throw new Error("No NIfTI files found");
  }

  // Get file sizes for heuristics
  const fileSizes = new Map<string, number>();
  for (const f of niftiFiles) {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folderUri, f));
    fileSizes.set(f, stat.size);
  }

  const lower = (s: string) => s.toLowerCase();

  // Classify files
  const isBase = (f: string) => {
    const l = lower(f);
    return l.includes("t1") || l.includes("preproc") || l.includes("normalized") || l.includes("n4") || l.includes("anat");
  };
  const isProb = (f: string) => {
    const l = lower(f);
    return l.includes("prob") || l.includes("probability");
  };
  const isMask = (f: string) => {
    const l = lower(f);
    return l.includes("mask") || l.includes("label") || l.includes("numbered") || l.includes("segm");
  };
  const isOverlayFile = (f: string) => isProb(f) || isMask(f);

  // Smart cmap detection
  const guessCmap = (f: string): string => {
    if (isProb(f)) return "hot";
    if (isMask(f)) return "rainbow";
    return "gray";
  };

  // Smart overlay mode detection
  const guessOverlayMode = (f: string): "filled" | "contour" | undefined => {
    if (isMask(f)) return "contour";
    if (isProb(f)) return "filled";
    return undefined;
  };

  type Panel = import("./templateProvider").ViewerTemplate["panels"][0];

  if (niftiFiles.length === 1) {
    // Single file: single panel
    const f = niftiFiles[0];
    return {
      version: 1,
      name: "Auto Generated",
      description: "Auto-generated template",
      viewer: { view: "multiplanar" },
      panels: [{
        title: f.replace(/\.nii(\.gz)?$/, ""),
        image: f,
        imageCmap: guessCmap(f),
      }],
    };
  }

  // Multiple files: identify base images and overlays
  const baseFiles = niftiFiles.filter(f => isBase(f) && !isOverlayFile(f));
  const overlayFiles = niftiFiles.filter(f => isOverlayFile(f));
  const otherFiles = niftiFiles.filter(f => !isBase(f) && !isOverlayFile(f));

  // If no base detected, use largest file as base
  let bases = baseFiles.length > 0 ? baseFiles : otherFiles.length > 0 ? otherFiles : niftiFiles;
  if (bases.length === 0) bases = [niftiFiles[0]];

  // Sort bases by size (largest first = most likely anatomical)
  bases.sort((a, b) => (fileSizes.get(b) || 0) - (fileSizes.get(a) || 0));

  const panels: Panel[] = [];

  if (overlayFiles.length > 0 && bases.length > 0) {
    // Try to pair overlays with bases
    // Simple: if 1 base, all overlays go on it; if multiple, distribute
    if (bases.length === 1) {
      const base = bases[0];
      // First overlay on the base panel
      const firstOvl = overlayFiles[0];
      panels.push({
        title: base.replace(/\.nii(\.gz)?$/, ""),
        image: base,
        imageCmap: guessCmap(base),
        overlay: firstOvl,
        overlayCmap: guessCmap(firstOvl),
        overlayMode: guessOverlayMode(firstOvl),
      });
      // Additional overlays as separate panels with same base
      for (let i = 1; i < overlayFiles.length; i++) {
        const ovl = overlayFiles[i];
        panels.push({
          title: `${base.replace(/\.nii(\.gz)?$/, "")} + ${ovl.replace(/\.nii(\.gz)?$/, "")}`,
          image: base,
          imageCmap: guessCmap(base),
          overlay: ovl,
          overlayCmap: guessCmap(ovl),
          overlayMode: guessOverlayMode(ovl),
        });
      }
      // Other non-base, non-overlay files as standalone panels
      for (const f of otherFiles.filter(f => !bases.includes(f))) {
        panels.push({
          title: f.replace(/\.nii(\.gz)?$/, ""),
          image: f,
          imageCmap: guessCmap(f),
        });
      }
    } else {
      // Multiple bases: each gets best-matching overlay if available
      for (const base of bases) {
        const baseStem = base.replace(/\.nii(\.gz)?$/, "").toLowerCase();
        // Find overlay with matching prefix
        const matchingOvl = overlayFiles.find(ovl => {
          const ovlLow = ovl.toLowerCase();
          return ovlLow.includes(baseStem.split("_")[0]);
        });
        panels.push({
          title: base.replace(/\.nii(\.gz)?$/, ""),
          image: base,
          imageCmap: guessCmap(base),
          overlay: matchingOvl,
          overlayCmap: matchingOvl ? guessCmap(matchingOvl) : undefined,
          overlayMode: matchingOvl ? guessOverlayMode(matchingOvl) : undefined,
        });
      }
      // Standalone overlays that weren't matched
      for (const ovl of overlayFiles) {
        if (!panels.some(p => p.overlay === ovl)) {
          panels.push({
            title: ovl.replace(/\.nii(\.gz)?$/, ""),
            image: bases[0],
            imageCmap: guessCmap(bases[0]),
            overlay: ovl,
            overlayCmap: guessCmap(ovl),
            overlayMode: guessOverlayMode(ovl),
          });
        }
      }
    }
  } else {
    // No overlays: each file is its own panel
    for (const f of niftiFiles) {
      panels.push({
        title: f.replace(/\.nii(\.gz)?$/, ""),
        image: f,
        imageCmap: guessCmap(f),
      });
    }
  }

  // Build grid: try to make a reasonable layout
  let grid: number[][] | undefined;
  if (panels.length > 1) {
    const nCols = panels.length <= 4 ? Math.min(panels.length, 2) : Math.ceil(Math.sqrt(panels.length));
    grid = [];
    for (let i = 0; i < panels.length; i += nCols) {
      grid.push(
        Array.from({ length: Math.min(nCols, panels.length - i) }, (_, j) => i + j)
      );
    }
  }

  return {
    version: 1,
    name: "Auto Generated",
    description: "Auto-generated template from folder contents",
    viewer: { view: "multiplanar" },
    panels,
    grid,
  };
}

async function sendTemplateData(
  panel: vscode.WebviewPanel,
  template: import("./templateProvider").ViewerTemplate,
  folderUri: vscode.Uri
): Promise<void> {
  const t0 = Date.now();

  // Read all unique files in parallel — raw bytes, no base64
  const fileCache = new Map<string, Uint8Array>();
  const uniquePaths = new Set<string>();
  for (const p of template.panels) {
    if (p.image) uniquePaths.add(p.image);
    if (p.overlay) uniquePaths.add(p.overlay);
  }
  const reads = Array.from(uniquePaths).map(async (relPath) => {
    const fileUri = vscode.Uri.joinPath(folderUri, relPath);
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    return { relPath, bytes: new Uint8Array(bytes) };
  });
  for (const result of await Promise.all(reads)) {
    fileCache.set(result.relPath, result.bytes);
  }

  const panels = template.panels.map((p) => ({
    title: p.title,
    imageBytes: fileCache.get(p.image)!,
    imageFilename: p.image.split("/").pop() || p.image,
    imageCmap: p.imageCmap,
    imageRange: p.imageRange,
    overlayBytes: p.overlay ? fileCache.get(p.overlay) : undefined,
    overlayFilename: p.overlay ? p.overlay.split("/").pop() || p.overlay : undefined,
    overlayCmap: p.overlayCmap,
    overlayRange: p.overlayRange,
    overlayMode: p.overlayMode,
  }));

  // Read findings JSON if specified
  let findings: Record<string, string> | undefined;
  if (template.findings) {
    try {
      const findingsUri = vscode.Uri.joinPath(folderUri, template.findings);
      const findingsBytes = await vscode.workspace.fs.readFile(findingsUri);
      findings = JSON.parse(Buffer.from(findingsBytes).toString("utf-8"));
    } catch {
      // Findings file not found — that's OK
    }
  }

  console.log(`[template] extension side: ${Date.now() - t0}ms`);

  panel.webview.postMessage({
    type: "apply-template",
    viewer: template.viewer || {},
    panels,
    grid: template.grid,
    findings,
  });
}

export function deactivate() {}
