import * as vscode from "vscode";

export interface ViewerTemplate {
  version: number;
  name: string;
  description?: string;
  viewer?: {
    view?: string;
    zoom?: number;
    alpha?: number;
    interpolation?: string;
    crosshairShow?: boolean;
    crosshairColor?: string;
    fullCrosshairs?: boolean;
    autoRange?: boolean;
    showOverlay?: boolean;
    showContour?: boolean;
    mainMultiView?: string;
  };
  panels: Array<{
    title?: string;
    image: string;
    imageCmap?: string;
    imageRange?: [number, number] | null;
    overlay?: string;
    overlayCmap?: string;
    overlayRange?: [number, number] | null;
    overlayMode?: "filled" | "contour";
  }>;
  grid?: number[][];
  findings?: string;  // relative path to classification JSON (e.g. "lesion_numbered_clf.json")
}

/**
 * Discover templates from project (.viewer/templates/) and global (~/.viewer/templates/) locations.
 * Project-level templates win on name collision.
 */
export async function discoverTemplates(
  workspaceFolder?: vscode.Uri,
  targetFolder?: vscode.Uri
): Promise<{ name: string; uri: vscode.Uri }[]> {
  const templates = new Map<string, vscode.Uri>();

  // Global templates (~/.viewer/templates/) — lowest priority
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    const globalDir = vscode.Uri.file(`${homeDir}/.viewer/templates`);
    await collectTemplates(globalDir, templates);
  }

  // Project templates (<workspace>/.viewer/templates/)
  if (workspaceFolder) {
    const projectDir = vscode.Uri.joinPath(workspaceFolder, ".viewer", "templates");
    await collectTemplates(projectDir, templates);
  }

  // Target folder templates (<folder>/.viewer/templates/) — highest priority
  if (targetFolder && targetFolder.toString() !== workspaceFolder?.toString()) {
    const folderDir = vscode.Uri.joinPath(targetFolder, ".viewer", "templates");
    await collectTemplates(folderDir, templates);
  }

  return Array.from(templates.entries()).map(([name, uri]) => ({ name, uri }));
}

async function collectTemplates(
  dir: vscode.Uri,
  templates: Map<string, vscode.Uri>
): Promise<void> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [filename, type] of entries) {
      if (type === vscode.FileType.File && filename.endsWith(".json")) {
        const name = filename.replace(/\.json$/, "");
        templates.set(name, vscode.Uri.joinPath(dir, filename));
      }
    }
  } catch {
    // Directory doesn't exist — that's fine
  }
}

/**
 * Parse a template JSON file.
 */
export async function parseTemplate(uri: vscode.Uri): Promise<ViewerTemplate> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString("utf-8");
  const template = JSON.parse(text) as ViewerTemplate;

  if (!template.version || !template.panels || !Array.isArray(template.panels)) {
    throw new Error("Invalid template: missing required fields (version, panels)");
  }
  if (template.panels.length === 0) {
    throw new Error("Invalid template: panels array is empty");
  }
  for (const panel of template.panels) {
    if (!panel.image) {
      throw new Error("Invalid template: each panel must have an 'image' field");
    }
  }

  return template;
}

/**
 * Check that all NIfTI files referenced in the template exist in the folder.
 */
export async function validateTemplateFiles(
  template: ViewerTemplate,
  folderUri: vscode.Uri
): Promise<{ valid: boolean; missing: string[] }> {
  const missing: string[] = [];
  const checked = new Set<string>();

  for (const panel of template.panels) {
    for (const relPath of [panel.image, panel.overlay]) {
      if (!relPath || checked.has(relPath)) continue;
      checked.add(relPath);
      const fileUri = vscode.Uri.joinPath(folderUri, relPath);
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        missing.push(relPath);
      }
    }
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Check if a folder contains any NIfTI files.
 */
export async function folderContainsNifti(folderUri: vscode.Uri): Promise<boolean> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(folderUri);
    return entries.some(
      ([name, type]) =>
        type === vscode.FileType.File &&
        (name.endsWith(".nii") || name.endsWith(".nii.gz"))
    );
  } catch {
    return false;
  }
}
