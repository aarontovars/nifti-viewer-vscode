import * as vscode from "vscode";

/**
 * Generate the HTML for the NIfTI viewer webview.
 * Shared by NiftiEditorProvider (single-file) and template-based viewer.
 */
export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  title: string
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "styles.css")
  );

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>${title}</title>
</head>
<body>
  <div id="menubar"></div>
  <div id="viewer-container">
    <div id="loading">Loading...</div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
