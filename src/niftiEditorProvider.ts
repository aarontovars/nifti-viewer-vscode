import * as vscode from "vscode";
import { getWebviewHtml } from "./webviewHtml";

export class NiftiEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private static readonly viewType = "niftiViewer.editor";
  static activePanels = new Set<vscode.WebviewPanel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new NiftiEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      NiftiEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "src"),
      ],
    };

    const filename = document.uri.path.split("/").pop() || "unknown";
    webviewPanel.webview.html = getWebviewHtml(
      webviewPanel.webview, this.context.extensionUri, filename
    );

    // Read raw file bytes (compressed .nii.gz or raw .nii)
    const fileBytes = await vscode.workspace.fs.readFile(document.uri);
    const rawBase64 = uint8ToBase64(new Uint8Array(fileBytes));

    // Register for capture command
    NiftiEditorProvider.activePanels.add(webviewPanel);
    webviewPanel.onDidDispose(() => NiftiEditorProvider.activePanels.delete(webviewPanel));

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          // Send raw file bytes — webview does all parsing
          webviewPanel.webview.postMessage({
            type: "load-file",
            rawBase64,
            filename,
          });
          break;

        case "capture-state-response": {
          const fs = require("fs");
          const path = require("path");
          const screenshotPath = path.join(require("os").tmpdir(), "nifti-viewer-screenshot.png");
          const statePath = path.join(require("os").tmpdir(), "nifti-viewer-state.json");
          const b64 = msg.screenshotBase64.replace(/^data:image\/png;base64,/, "");
          fs.writeFileSync(screenshotPath, Buffer.from(b64, "base64"));
          fs.writeFileSync(statePath, JSON.stringify(msg.state, null, 2));
          vscode.window.showInformationMessage(`Screenshot saved to ${screenshotPath}`);
          break;
        }

        case "load-overlay":
          await this.handleLoadOverlay(webviewPanel, msg.slotNames);
          break;

        case "load-new-image":
          await this.handleLoadNewImage(webviewPanel);
          break;

        case "add-image":
          await this.handleAddImage(webviewPanel);
          break;

        case "open-new-tab": {
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { "NIfTI files": ["nii", "nii.gz", "gz"] },
            title: "Open NIfTI in new tab",
          });
          if (uris && uris.length > 0) {
            vscode.commands.executeCommand("vscode.openWith", uris[0], "niftiViewer.editor");
          }
          break;
        }
      }
    });
  }

  private async handleLoadNewImage(
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "NIfTI files": ["nii", "nii.gz", "gz"] },
      title: "Select NIfTI file to open",
    });

    if (!uris || uris.length === 0) return;

    try {
      const fileBytes = await vscode.workspace.fs.readFile(uris[0]);
      const rawBase64 = uint8ToBase64(new Uint8Array(fileBytes));
      const filename = uris[0].path.split("/").pop() || "unknown";

      webviewPanel.webview.postMessage({
        type: "load-file",
        rawBase64,
        filename,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to load image: ${err.message}`);
    }
  }

  private async handleAddImage(
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "NIfTI files": ["nii", "nii.gz", "gz"] },
      title: "Add image side-by-side",
    });
    if (!uris || uris.length === 0) return;

    try {
      const fileBytes = await vscode.workspace.fs.readFile(uris[0]);
      const rawBase64 = uint8ToBase64(new Uint8Array(fileBytes));
      const filename = uris[0].path.split("/").pop() || "unknown";
      webviewPanel.webview.postMessage({ type: "add-image-file", rawBase64, filename });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to add image: ${err.message}`);
    }
  }

  private async handleLoadOverlay(
    webviewPanel: vscode.WebviewPanel,
    slotNames?: string[]
  ): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "NIfTI files": ["nii", "nii.gz", "gz"] },
      title: "Select overlay NIfTI file",
    });

    if (!uris || uris.length === 0) return;

    // If multiple images loaded, ask which one to overlay on
    let targetSlot: number | "all" = 0;
    if (slotNames && slotNames.length > 1) {
      const items = [
        { label: "All images", value: "all" as const },
        ...slotNames.map((name, i) => ({ label: `${i + 1}: ${name}`, value: i })),
      ];
      const pick = await vscode.window.showQuickPick(
        items.map(it => it.label),
        { placeHolder: "Apply overlay to which image?" }
      );
      if (!pick) return;
      const found = items.find(it => it.label === pick);
      if (!found) return;
      targetSlot = found.value;
    }

    try {
      const fileBytes = await vscode.workspace.fs.readFile(uris[0]);
      const rawBase64 = uint8ToBase64(new Uint8Array(fileBytes));
      const filename = uris[0].path.split("/").pop() || "overlay";

      webviewPanel.webview.postMessage({
        type: "load-overlay-file",
        rawBase64,
        filename,
        targetSlot,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to load overlay: ${err.message}`);
    }
  }

}

/** Encode Uint8Array to base64 efficiently */
function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return Buffer.from(binary, "binary").toString("base64");
}
