import { VscodeViewer } from "./vscodeViewer";
import { loadNifti, computeRange, computeFullRange, isIntegerVolume } from "../niftiLoader";
import { buildMenuBar } from "./menubar";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
let viewer: VscodeViewer | null = null;
let currentFilename = "";

vscode.postMessage({ type: "ready" });

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "load-file":
      handleLoadFile(msg.rawBase64, msg.filename);
      break;
    case "add-image-file":
      handleAddImage(msg.rawBase64, msg.filename);
      break;
    case "load-overlay-file":
      handleLoadOverlay(msg.rawBase64, msg.filename, msg.targetSlot);
      break;
    case "apply-template":
      handleApplyTemplate(msg);
      break;
    case "navigate-label":
      if (viewer && typeof msg.label === "number") {
        viewer.navigateToLabel(msg.label);
        viewer.onStateChanged?.();
      }
      break;
    case "navigate-position":
      if (viewer && Array.isArray(msg.position)) {
        viewer.setPosition(msg.position as [number, number, number]);
      }
      break;
    case "capture-state":
      if (viewer) {
        const capture = viewer.captureState();
        vscode.postMessage({ type: "capture-state-response", ...capture });
      }
      break;
    case "get-slot-names":
      vscode.postMessage({ type: "slot-names-response", slotNames: viewer?.getSlotNames() ?? [] });
      break;
  }
});

/**
 * Compute overlay range matching notebook-viewer behavior: [min_nonzero, max].
 * This ensures probabilistic overlays use the full colormap range for non-zero voxels,
 * rather than compressing the range due to the large number of zero-valued voxels.
 */
function computeOverlayRange(data: Float32Array): [number, number] {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v > 0 && !isNaN(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) return [0, 1]; // all zeros
  if (min >= max) return [0, max]; // binary/degenerate → use [0, max] so colormap spans properly
  return [min, max];
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseVolume(rawBase64: string, filename: string) {
  const rawBytes = base64ToUint8(rawBase64);
  const volume = loadNifti(rawBytes);
  const range = computeRange(volume.data);
  const fullRange = computeFullRange(volume.data);
  const isInteger = isIntegerVolume(volume.data);
  const center: [number, number, number] = [
    Math.floor(volume.shape[0] / 2),
    Math.floor(volume.shape[1] / 2),
    Math.floor(volume.shape[2] / 2),
  ];
  return {
    info: {
      shape: volume.shape,
      voxelSizes: volume.voxelSizes,
      center, range, fullRange, isInteger, filename,
      affine: volume.affine,
      orientDebug: volume.orientDebug,
    },
    data: volume.data,
  };
}

function handleLoadFile(rawBase64: string, filename: string): void {
  const container = document.getElementById("viewer-container")!;
  const menubar = document.getElementById("menubar")!;

  container.innerHTML = '<div id="loading">Loading\u2026</div>';

  requestAnimationFrame(() => {
    try {
      const vol = parseVolume(rawBase64, filename);

      if (viewer) viewer.destroy();
      container.innerHTML = "";

      currentFilename = filename;
      viewer = new VscodeViewer(container, vol.info, vol.data);
      viewer.onCloseRequest = () => {
        if (viewer) { viewer.destroy(); viewer = null; }
        container.innerHTML = '<div id="loading">No image loaded</div>';
        menubar.innerHTML = "";
      };
      viewer.onStateChanged = () => rebuildMenu();
      viewer.onAddImageRequest = () => vscode.postMessage({ type: "add-image" });
      viewer.onAddOverlayRequest = () => vscode.postMessage({ type: "load-overlay", slotNames: viewer?.getSlotNames() || [] });
      setupMenuBar(menubar);
      viewer.init();
    } catch (err: any) {
      container.innerHTML = `<div id="loading" style="color:#f44">Error: ${err.message}</div>`;
    }
  });
}

function handleAddImage(rawBase64: string, filename: string): void {
  if (!viewer) {
    handleLoadFile(rawBase64, filename);
    return;
  }

  try {
    const vol = parseVolume(rawBase64, filename);
    viewer.addImage(vol.info, vol.data);
    viewer.render();
    rebuildMenu();
  } catch (err: any) {
    console.error("Failed to add image:", err);
  }
}

function handleLoadOverlay(rawBase64: string, _filename: string, targetSlot?: number | "all"): void {
  if (!viewer) return;
  try {
    const rawBytes = base64ToUint8(rawBase64);
    const volume = loadNifti(rawBytes);
    const range = computeOverlayRange(volume.data);
    if (targetSlot === "all") {
      viewer.addOverlayToAll(volume.data, range, volume.shape);
    } else if (typeof targetSlot === "number") {
      viewer.addOverlayToSlot(targetSlot, volume.data, range, volume.shape);
    } else {
      viewer.addOverlay(volume.data, range, volume.shape);
    }
  } catch (err: any) {
    console.error("Failed to load overlay:", err);
  }
}

function rebuildMenu(): void {
  const menubar = document.getElementById("menubar")!;
  if (!viewer) return;
  setupMenuBar(menubar);
}

function setupMenuBar(menubar: HTMLElement): void {
  if (!viewer) return;
  buildMenuBar(menubar, currentFilename, viewer, {
    onLoadImage: () => vscode.postMessage({ type: "load-new-image" }),
    onAddImage: () => vscode.postMessage({ type: "add-image" }),
    onOpenNewTab: () => vscode.postMessage({ type: "open-new-tab" }),
    onLoadOverlay: () => vscode.postMessage({ type: "load-overlay", slotNames: viewer?.getSlotNames() || [] }),
    onChanged: rebuildMenu,
  });
}

function parseVolumeFromBytes(rawBytes: Uint8Array, filename: string) {
  const volume = loadNifti(rawBytes);
  const range = computeRange(volume.data);
  const fullRange = computeFullRange(volume.data);
  const isInteger = isIntegerVolume(volume.data);
  const center: [number, number, number] = [
    Math.floor(volume.shape[0] / 2),
    Math.floor(volume.shape[1] / 2),
    Math.floor(volume.shape[2] / 2),
  ];
  return {
    info: {
      shape: volume.shape,
      voxelSizes: volume.voxelSizes,
      center, range, fullRange, isInteger, filename,
      affine: volume.affine,
      orientDebug: volume.orientDebug,
    },
    data: volume.data,
  };
}

// Structured clone may deliver Uint8Array or a plain object with .data
function toUint8Array(v: { data: number[] } | Uint8Array): Uint8Array {
  if (v instanceof Uint8Array) return v;
  return new Uint8Array(v.data);
}

function handleApplyTemplate(msg: {
  viewer: Record<string, any>;
  panels: Array<{
    title?: string;
    imageBytes: { data: number[] } | Uint8Array;
    imageFilename: string;
    imageCmap?: string;
    imageRange?: [number, number] | null;
    overlayBytes?: { data: number[] } | Uint8Array;
    overlayFilename?: string;
    overlayCmap?: string;
    overlayRange?: [number, number] | null;
    overlayMode?: "filled" | "contour";
  }>;
  grid?: number[][];
  folderPath?: string;
  templateName?: string;
}): void {
  const container = document.getElementById("viewer-container")!;
  const menubar = document.getElementById("menubar")!;

  container.innerHTML = '<div id="loading">Loading\u2026</div>';

  // Use setTimeout(0) to yield between heavy parses so the loading text updates
  const yieldTick = () => new Promise<void>(r => setTimeout(r, 0));

  (async () => {
    try {
      const t0 = performance.now();
      const loading = document.getElementById("loading")!;

      // Parse all volumes, yielding between each, deduplicating by filename
      type ParsedVol = ReturnType<typeof parseVolumeFromBytes>;
      const volCache = new Map<string, ParsedVol>();
      const parsed: { vol: ParsedVol; overlayData?: Float32Array; overlayShape?: [number, number, number]; overlayRange?: [number, number] }[] = [];

      for (let i = 0; i < msg.panels.length; i++) {
        const panel = msg.panels[i];

        // Parse image (deduplicated)
        let vol = volCache.get(panel.imageFilename);
        if (!vol) {
          loading.textContent = `Parsing ${panel.imageFilename}\u2026`;
          await yieldTick();
          vol = parseVolumeFromBytes(toUint8Array(panel.imageBytes), panel.imageFilename);
          volCache.set(panel.imageFilename, vol);
        }

        // Parse overlay
        let overlayData: Float32Array | undefined;
        let overlayShape: [number, number, number] | undefined;
        let overlayRange: [number, number] | undefined;
        if (panel.overlayBytes && panel.overlayFilename) {
          loading.textContent = `Parsing ${panel.overlayFilename}\u2026`;
          await yieldTick();
          const volume = loadNifti(toUint8Array(panel.overlayBytes));
          overlayData = volume.data;
          overlayShape = volume.shape;
          overlayRange = panel.overlayRange as [number, number] || computeOverlayRange(volume.data);
        }

        parsed.push({ vol, overlayData, overlayShape, overlayRange });
      }

      console.log(`[template-wv] parsing: ${(performance.now() - t0).toFixed(0)}ms`);

      // Assemble viewer
      if (viewer) viewer.destroy();
      container.innerHTML = "";

      const firstPanel = msg.panels[0];
      currentFilename = firstPanel.title || firstPanel.imageFilename;
      viewer = new VscodeViewer(container, parsed[0].vol.info, parsed[0].vol.data);

      // Apply global viewer settings
      const v = msg.viewer;
      if (v.view) viewer.view = v.view as any;
      if (v.zoom !== undefined) viewer.zoomFactor = v.zoom;
      if (v.alpha !== undefined) viewer.alpha = v.alpha;
      if (v.interpolation !== undefined) viewer.smoothInterp = v.interpolation !== "nearest";
      if (v.crosshairShow !== undefined) viewer.showCrosshairs = v.crosshairShow;
      if (v.crosshairColor !== undefined) viewer.crosshairColor = v.crosshairColor;
      if (v.fullCrosshairs !== undefined) viewer.fullCrosshairs = v.fullCrosshairs;
      if (v.autoRange !== undefined) viewer.autoRange = v.autoRange;
      if (v.showOverlay !== undefined) viewer.showOverlay = v.showOverlay;
      if (v.showContour !== undefined) viewer.showContour = v.showContour;
      if (v.mainMultiView) viewer.mainMultiView = v.mainMultiView as any;

      if (firstPanel.title) viewer.setSlotTitle(0, firstPanel.title);
      if (firstPanel.imageCmap) viewer.setImageColormap(firstPanel.imageCmap);
      if (firstPanel.imageRange) viewer.setSlotImageRange(0, firstPanel.imageRange);

      for (let i = 1; i < msg.panels.length; i++) {
        const panel = msg.panels[i];
        viewer.addImage(parsed[i].vol.info, parsed[i].vol.data);
        if (panel.title) viewer.setSlotTitle(i, panel.title);
        if (panel.imageRange) viewer.setSlotImageRange(i, panel.imageRange);
      }

      for (let i = 0; i < msg.panels.length; i++) {
        const p = parsed[i];
        if (p.overlayData) {
          viewer.addOverlayToSlot(i, p.overlayData, p.overlayRange!, p.overlayShape, msg.panels[i].overlayMode, msg.panels[i].overlayCmap);
        }
      }

      if (msg.grid) viewer.setGrid(msg.grid);

      // Set global overlay colormap from first panel that has one (fallback for interactive use)
      for (const panel of msg.panels) {
        if (panel.overlayCmap) { viewer.setOverlayColormap(panel.overlayCmap); break; }
      }

      viewer.onCloseRequest = () => {
        if (viewer) { viewer.destroy(); viewer = null; }
        container.innerHTML = '<div id="loading">No image loaded</div>';
        menubar.innerHTML = "";
        removeFindingsPanel();
      };
      viewer.onStateChanged = () => rebuildMenu();
      viewer.onAddImageRequest = () => vscode.postMessage({ type: "add-image" });
      viewer.onAddOverlayRequest = () => vscode.postMessage({ type: "load-overlay", slotNames: viewer?.getSlotNames() || [] });
      viewer.onLabelClicked = (slotIdx, label) => {
        vscode.postMessage({ type: "label-clicked", slotIdx, label });
        highlightFinding(label);
      };

      setupMenuBar(menubar);
      viewer.init();

      // Save state for deserialization after extension-host restart
      if (msg.folderPath && msg.templateName) {
        vscode.setState({ folderPath: msg.folderPath, templateName: msg.templateName });
      }

      // Build findings panel if data provided
      if (msg.findings) {
        buildFindingsPanel(msg.findings, container);
      }

      console.log(`[template-wv] total: ${(performance.now() - t0).toFixed(0)}ms`);
    } catch (err: any) {
      container.innerHTML = `<div id="loading" style="color:#f44">Error: ${err.message}</div>`;
    }
  })();
}

// ── Findings Panel ────────────────────────────────────────────────

let findingsData: Record<string, string> | null = null;
let findingsActiveLabel: number | null = null;
let findingsActiveTab = "active";

function removeFindingsPanel(): void {
  findingsData = null;
  const panel = document.getElementById("findings-panel");
  const wrapper = document.getElementById("findings-wrapper");
  if (wrapper && panel) {
    const container = document.getElementById("viewer-container");
    if (container) {
      wrapper.parentElement!.insertBefore(container, wrapper);
      container.style.flex = "";
    }
    wrapper.remove();
  } else {
    panel?.remove();
  }
}

function highlightFinding(label: number): void {
  if (!findingsData) return;
  findingsActiveLabel = label;
  const type = findingsData[String(label)];
  if (type === "stable" && findingsActiveTab !== "stable") showFindingsTab("stable");
  else if (type !== "stable" && findingsActiveTab !== "active") showFindingsTab("active");
  else updateFindingsHighlight();
  const el = document.querySelector(`.fp-item[data-label="${label}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function buildFindingsPanel(clf: Record<string, string>, viewerContainer: HTMLElement): void {
  removeFindingsPanel();
  findingsData = clf;
  findingsActiveLabel = null;
  findingsActiveTab = "active";

  // Group
  const groups: Record<string, number[]> = { new: [], enlarging: [], stable: [] };
  for (const [label, type] of Object.entries(clf)) {
    if (!groups[type]) groups[type] = [];
    groups[type].push(parseInt(label));
  }
  for (const g of Object.values(groups)) g.sort((a, b) => a - b);

  const activeCount = (groups.new?.length || 0) + (groups.enlarging?.length || 0);
  const stableCount = groups.stable?.length || 0;

  const panel = document.createElement("div");
  panel.id = "findings-panel";
  panel.innerHTML = `
    <style>
      #findings-panel {
        width: 220px; min-width: 220px;
        background: #1a1a1a; border-left: 1px solid #333; display: flex;
        flex-direction: column; font-family: system-ui, sans-serif;
      }
      .fp-header { padding: 8px 10px; font-size: 11px; color: #999; text-transform: uppercase;
        letter-spacing: 0.04em; border-bottom: 1px solid #333; font-weight: 600; }
      .fp-summary { padding: 6px 10px; font-size: 11px; color: #888; border-bottom: 1px solid #333; }
      .fp-summary .new { color: #F31260; font-weight: 600; }
      .fp-summary .enlarging { color: #C3841D; font-weight: 600; }
      .fp-summary .stable { color: #12A150; font-weight: 600; }
      .fp-tabs { display: flex; border-bottom: 1px solid #333; }
      .fp-tab { flex: 1; padding: 6px 8px; font-size: 10px; text-align: center; cursor: pointer;
        color: #888; background: none; border: none; border-bottom: 2px solid transparent;
        text-transform: uppercase; letter-spacing: 0.03em; font-weight: 600; }
      .fp-tab:hover { color: #ccc; background: #222; }
      .fp-tab.active { color: #5294F4; border-bottom-color: #5294F4; }
      .fp-list { flex: 1; overflow-y: auto; padding: 2px 0; }
      .fp-group { padding: 6px 10px 2px; font-size: 9px; text-transform: uppercase;
        color: #666; font-weight: 600; letter-spacing: 0.04em; }
      .fp-item { display: flex; align-items: center; gap: 6px; padding: 4px 10px; cursor: pointer;
        font-size: 12px; color: #999; border-left: 3px solid transparent; }
      .fp-item:hover { background: #222; color: #ddd; }
      .fp-item.active { background: #222; color: #eee; border-left-color: #5294F4; }
      .fp-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .fp-dot.new { background: #F31260; }
      .fp-dot.enlarging { background: #C3841D; }
      .fp-dot.stable { background: #12A150; }
      .fp-empty { padding: 10px; font-size: 11px; color: #666; }
    </style>
    <div class="fp-header">Findings</div>
    <div class="fp-summary" id="fp-summary"></div>
    <div class="fp-tabs">
      ${activeCount > 0 ? `<button class="fp-tab active" data-tab="active" id="fp-tab-active">New / Enlarging (${activeCount})</button>` : ""}
      ${stableCount > 0 ? `<button class="fp-tab${activeCount === 0 ? " active" : ""}" data-tab="stable" id="fp-tab-stable">Stable (${stableCount})</button>` : ""}
    </div>
    <div class="fp-list" id="fp-list"></div>
  `;

  // Wrap the viewer container in a flex row with the findings panel beside it
  const parent = viewerContainer.parentElement!;
  const wrapper = document.createElement("div");
  wrapper.id = "findings-wrapper";
  wrapper.style.cssText = "display:flex;flex:1;overflow:hidden;";
  parent.insertBefore(wrapper, viewerContainer);
  viewerContainer.style.flex = "1";
  wrapper.appendChild(viewerContainer);
  wrapper.appendChild(panel);

  // Summary
  const parts: string[] = [];
  if (groups.new?.length) parts.push(`<span class="new">${groups.new.length} new</span>`);
  if (groups.enlarging?.length) parts.push(`<span class="enlarging">${groups.enlarging.length} enlarging</span>`);
  if (groups.stable?.length) parts.push(`<span class="stable">${groups.stable.length} stable</span>`);
  document.getElementById("fp-summary")!.innerHTML = parts.join(" · ") + ` · ${Object.keys(clf).length} total`;

  // Tab events
  panel.querySelectorAll(".fp-tab").forEach((tab) => {
    (tab as HTMLElement).addEventListener("click", () => showFindingsTab((tab as HTMLElement).dataset.tab!));
  });

  // Store groups globally for tab rendering
  (window as any).__fpGroups = groups;
  showFindingsTab(activeCount > 0 ? "active" : "stable");
}

function showFindingsTab(tab: string): void {
  findingsActiveTab = tab;
  document.querySelectorAll(".fp-tab").forEach((t) =>
    t.classList.toggle("active", (t as HTMLElement).dataset.tab === tab)
  );

  const list = document.getElementById("fp-list");
  if (!list) return;
  const groups = (window as any).__fpGroups as Record<string, number[]>;

  let html = "";
  if (tab === "active") {
    for (const type of ["new", "enlarging"]) {
      const labels = groups[type] || [];
      if (labels.length === 0) continue;
      html += `<div class="fp-group">${type} (${labels.length})</div>`;
      for (const l of labels) {
        html += `<div class="fp-item${l === findingsActiveLabel ? " active" : ""}" data-label="${l}"><span class="fp-dot ${type}"></span>Lesion ${l}</div>`;
      }
    }
    if (!html) html = '<div class="fp-empty">No new or enlarging lesions</div>';
  } else {
    const labels = groups.stable || [];
    for (const l of labels) {
      html += `<div class="fp-item${l === findingsActiveLabel ? " active" : ""}" data-label="${l}"><span class="fp-dot stable"></span>Lesion ${l}</div>`;
    }
    if (!html) html = '<div class="fp-empty">No stable lesions</div>';
  }
  list.innerHTML = html;

  list.querySelectorAll(".fp-item").forEach((el) => {
    el.addEventListener("click", () => {
      const label = parseInt((el as HTMLElement).dataset.label!);
      findingsActiveLabel = label;
      updateFindingsHighlight();
      if (viewer) {
        viewer.navigateToLabel(label);
        viewer.onStateChanged?.();
      }
      // Refocus canvas so keyboard shortcuts keep working
      document.querySelector("canvas")?.focus();
    });
  });
}

function updateFindingsHighlight(): void {
  document.querySelectorAll(".fp-item").forEach((el) => {
    el.classList.toggle("active", parseInt((el as HTMLElement).dataset.label!) === findingsActiveLabel);
  });
}
