/**
 * Lightweight NIfTI viewer for VS Code.
 * Single full-screen canvas. Supports multiple synced images side by side.
 */

import { getLUT, COLORMAP_DEFS } from "../../viewer/colormaps";
import { extractSlice, findBoundaries } from "../../viewer/slicing";
import {
  renderSliceToImageData,
  renderOverlayToImageData,
  getAspectRatio,
  getCrosshairPos,
  computeViewport,
} from "../../viewer/rendering";
import type { SingleView, Viewport } from "../../viewer/types";

// Register discrete/label colormap: ~20 maximally distinct colors, 0 = transparent
const DISCRETE_COLORS: [number, number, number][] = [
  [230, 25, 75],   [60, 180, 75],   [255, 225, 25],  [0, 130, 200],
  [245, 130, 48],  [145, 30, 180],  [70, 240, 240],  [240, 50, 230],
  [210, 245, 60],  [250, 190, 212], [0, 128, 128],   [220, 190, 255],
  [170, 110, 40],  [255, 250, 200], [128, 0, 0],     [170, 255, 195],
  [128, 128, 0],   [255, 215, 180], [0, 0, 128],     [128, 128, 128],
];
COLORMAP_DEFS["discrete"] = (t: number): [number, number, number] => {
  // Map 0 → index 0 (will be transparent via overlay renderer), 1-20 → distinct colors
  const idx = Math.round(t * 255);
  if (idx <= 0) return [0, 0, 0];
  return DISCRETE_COLORS[(idx - 1) % DISCRETE_COLORS.length];
};

type ViewType = "axial" | "coronal" | "sagittal" | "multiplanar";
const VIEW_CYCLE: ViewType[] = ["axial", "coronal", "sagittal", "multiplanar"];
const SINGLE_VIEWS: SingleView[] = ["sagittal", "coronal", "axial"];

export interface ViewerInfo {
  shape: [number, number, number];
  voxelSizes: [number, number, number];
  center: [number, number, number];
  range: [number, number];
  fullRange: [number, number];
  isInteger: boolean;
  filename: string;
  affine?: number[][];
  orientDebug?: string;
}

interface ImageSlot {
  info: ViewerInfo;
  data: Float32Array;
  overlays: { data: Float32Array; range: [number, number]; isInteger: boolean; labels: number[]; shape: [number, number, number]; mode?: "filled" | "contour"; cmap?: string }[];
  imageRange: [number, number];
  fullRange: [number, number];
  pos: number[];
  viewport: Viewport;
  customTitle?: string;
}

interface ViewRegion {
  view: SingleView;
  slotIdx: number;
  dx: number; dy: number; dw: number; dh: number;
  sliceW: number; sliceH: number;
  scaleX: number; scaleY: number;
  isTitle?: boolean; // marker for title region
}

const ORI: Record<SingleView, [string, string, string, string]> = {
  axial:    ["A", "P", "R", "L"],
  coronal:  ["S", "I", "R", "L"],
  sagittal: ["S", "I", "A", "P"],
};

export class VscodeViewer {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tmp: HTMLCanvasElement;
  private tmpCtx: CanvasRenderingContext2D;
  private dpr: number;
  private ro: ResizeObserver | null = null;
  private regions: ViewRegion[] = [];
  private renderPending = false;
  private dragging = false;
  private dragLastY = 0;
  dragScrollMode = false;

  // Grid layout: array of rows, each row is array of slot indices
  private gridRows: number[][] = [];
  private gridManual = false; // true once user has dragged to rearrange

  // Title editing state
  private activeEditInput: HTMLInputElement | null = null;

  // Pending click (delayed to allow dblclick to intercept)
  private pendingClickTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingClickEvent: PointerEvent | null = null;

  // Pending title drag (delayed to allow dblclick to intercept)
  private pendingDragTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDragSlot = -1;
  private pendingDragMx = 0;
  private pendingDragMy = 0;

  // Slot drag-reorder state
  private slotDragging = false;
  private slotDragIdx = -1;
  private slotDragMx = 0;
  private slotDragMy = 0;
  /** Drop zone: "left-of-S", "right-of-S", "above-S", "below-S", or null */
  private dropZone: { slot: number; side: "left" | "right" | "top" | "bottom" | "swap" } | null = null;

  // Multiple images
  private slots: ImageSlot[] = [];
  private activeSlot = 0;

  // Public state
  view: ViewType = "multiplanar";
  focusedView: SingleView = "axial";
  /** Which view occupies the large panel in multiplanar (left half) */
  mainMultiView: SingleView = "axial";
  zoomFactor = 1;
  showCrosshairs = true;
  showOverlay = true;
  showContour = false;
  /** Contour cycle: "template" uses per-overlay modes, "all-contour" forces contour, "all-filled" forces filled */
  contourCycleState: "template" | "all-contour" | "all-filled" = "template";
  alpha = 1.0;
  smoothInterp = false;
  fullCrosshairs = true;
  crosshairColor = "#00ff00";
  imageColormaps: string[] = ["gray"];
  overlayColormaps: string[] = ["rainbow"];
  currentMaskIndex = 0;
  currentLabel: number | null = null;
  autoRange = true;

  onCloseRequest?: () => void;
  onStateChanged?: () => void;
  onAddImageRequest?: () => void;
  onAddOverlayRequest?: () => void;

  constructor(container: HTMLElement, info: ViewerInfo, imageData: Float32Array) {
    this.container = container;
    this.dpr = window.devicePixelRatio || 1;

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.tmp = document.createElement("canvas");
    this.tmpCtx = this.tmp.getContext("2d")!;

    this.addImage(info, imageData);
  }

  get config() { return this.slots[this.activeSlot]?.info; }
  get slotCount() { return this.slots.length; }
  get pos() { return this.slots[this.activeSlot]?.pos || [0, 0, 0]; }
  getSlotNames(): string[] { return this.slots.map(s => s.customTitle || s.info.filename); }

  /** Capture current canvas as base64 PNG + viewer state */
  captureState(): { screenshotBase64: string; state: Record<string, any> } {
    const screenshotBase64 = this.canvas.toDataURL("image/png");
    const state: Record<string, any> = {
      view: this.view,
      focusedView: this.focusedView,
      activeSlot: this.activeSlot,
      position: this.pos,
      zoomFactor: this.zoomFactor,
      showOverlay: this.showOverlay,
      showContour: this.showContour,
      contourCycleState: this.contourCycleState,
      alpha: this.alpha,
      interpolation: this.smoothInterp ? "linear" : "nearest",
      currentLabel: this.currentLabel,
      panels: this.slots.map((s, i) => ({
        index: i,
        title: s.customTitle || s.info.filename,
        filename: s.info.filename,
        shape: s.info.shape,
        voxelSizes: s.info.voxelSizes,
        imageRange: s.imageRange,
        imageCmap: this.imageColormaps[i] || this.imageColormaps[0],
        hasOverlay: s.overlays.length > 0,
        overlayLabels: s.overlays.length > 0 ? s.overlays[0].labels : [],
      })),
    };
    return { screenshotBase64, state };
  }

  /** Show a brief toast notification over the canvas */
  private showToast(msg: string): void {
    const toast = document.createElement("div");
    toast.textContent = msg;
    toast.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#333;color:#7f7;padding:10px 24px;border-radius:8px;font-size:14px;font-family:monospace;z-index:9999;opacity:0.95;pointer-events:none;transition:opacity 0.5s";
    this.container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; }, 1200);
    setTimeout(() => { toast.remove(); }, 1700);
  }

  /** Current display range [min, max] for the active slot */
  getDisplayRange(): [number, number] { return this.slots[this.activeSlot]?.imageRange || [0, 1]; }
  /** Full data range [min, max] for the active slot */
  getFullRange(): [number, number] { return this.slots[this.activeSlot]?.fullRange || [0, 1]; }

  setDisplayRange(lo: number, hi: number): void {
    const slot = this.slots[this.activeSlot];
    if (!slot) return;
    slot.imageRange = [lo, hi];
    this.render();
  }

  /** Current overlay range [min, max] for the active slot's first overlay */
  getOverlayRange(): [number, number] {
    const slot = this.slots[this.activeSlot];
    if (!slot || slot.overlays.length === 0) return [0, 1];
    return slot.overlays[0].range;
  }

  /** Full overlay range (min_nonzero, max) for the active slot's first overlay */
  getOverlayFullRange(): [number, number] {
    const slot = this.slots[this.activeSlot];
    if (!slot || slot.overlays.length === 0) return [0, 1];
    const data = slot.overlays[0].data;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v > 0 && !isNaN(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return min === Infinity ? [0, 1] : [0, max];
  }

  setOverlayRange(lo: number, hi: number): void {
    const slot = this.slots[this.activeSlot];
    if (!slot || slot.overlays.length === 0) return;
    slot.overlays[0].range = [lo, hi];
    this.render();
  }

  /** Reset overlay range to [min_nonzero, max] for the active slot */
  resetOverlayRange(): void {
    const full = this.getOverlayFullRange();
    const slot = this.slots[this.activeSlot];
    if (!slot || slot.overlays.length === 0) return;
    // For overlay: use min_nonzero as lower bound
    const data = slot.overlays[0].data;
    let minNZ = Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v > 0 && !isNaN(v) && v < minNZ) minNZ = v;
    }
    slot.overlays[0].range = [minNZ === Infinity ? 0 : minNZ, full[1]];
    this.render();
  }

  /** Get total overlay count across ALL slots */
  getOverlayCount(): number {
    let total = 0;
    for (const slot of this.slots) total += slot.overlays.length;
    return total;
  }

  /** Get overlay count for a specific slot */
  getSlotOverlayCount(slotIdx: number): number {
    return this.slots[slotIdx]?.overlays.length || 0;
  }

  /** Get all overlays as {slotIdx, overlayIdx, labels, isInteger} for the menu */
  getAllOverlayInfo(): { slotIdx: number; overlayIdx: number; name: string; labels: number[] }[] {
    const result: { slotIdx: number; overlayIdx: number; name: string; labels: number[] }[] = [];
    let globalIdx = 0;
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      const imgName = slot.customTitle || slot.info.filename;
      const shortName = imgName.length > 25 ? imgName.slice(-25) : imgName;
      for (let o = 0; o < slot.overlays.length; o++) {
        const ovl = slot.overlays[o];
        const suffix = slot.overlays.length > 1 ? ` #${o + 1}` : "";
        result.push({
          slotIdx: s,
          overlayIdx: o,
          name: `${shortName}${suffix}`,
          labels: ovl.labels,
        });
        globalIdx++;
      }
    }
    return result;
  }

  /** Get labels from the currently selected mask */
  getOverlayLabels(): number[] {
    const all = this.getAllOverlayInfo();
    if (all.length === 0) return [];
    const idx = Math.min(this.currentMaskIndex, all.length - 1);
    return all[idx].labels;
  }

  /** The currently active mask's global index */
  get activeMaskGlobalIdx(): number {
    return Math.min(this.currentMaskIndex, Math.max(0, this.getAllOverlayInfo().length - 1));
  }

  /** Set which overlay (global index across all slots) is used for label navigation */
  setMaskIndex(idx: number): void {
    const all = this.getAllOverlayInfo();
    if (idx < 0 || idx >= all.length) return;
    this.currentMaskIndex = idx;
    this.currentLabel = null;
    const labels = all[idx].labels;
    if (labels.length > 0) this.currentLabel = labels[0];
    this.onStateChanged?.();
  }

  /** Navigate to a specific label's center of mass */
  navigateToLabel(label: number): void {
    const all = this.getAllOverlayInfo();
    if (all.length === 0) return;
    this.currentLabel = label;
    // Find the overlay that contains this label (search all, not just current mask)
    let maskInfo = all[Math.min(this.currentMaskIndex, all.length - 1)];
    let slot = this.slots[maskInfo.slotIdx];
    let ovl = slot?.overlays[maskInfo.overlayIdx];
    // If label not in current mask, search all overlays
    if (!ovl || !ovl.labels.includes(label)) {
      for (const info of all) {
        if (info.labels.includes(label)) {
          maskInfo = info;
          slot = this.slots[info.slotIdx];
          ovl = slot?.overlays[info.overlayIdx];
          break;
        }
      }
    }
    if (!slot || !ovl) return;
    const s = ovl.shape;
    console.log(`[navigate] label=${label} slot=${maskInfo.slotIdx} ovl.shape=${s} slot.shape=${slot.info.shape} ovl.labels=${ovl.labels} dataLen=${ovl.data.length}`);
    // Find center of mass for this label
    let sx = 0, sy = 0, sz = 0, count = 0;
    for (let x = 0; x < s[0]; x++) {
      for (let y = 0; y < s[1]; y++) {
        for (let z = 0; z < s[2]; z++) {
          if (Math.round(ovl.data[x * s[1] * s[2] + y * s[2] + z]) === label) {
            sx += x; sy += y; sz += z; count++;
          }
        }
      }
    }
    console.log(`[navigate] count=${count} pos=${count > 0 ? [Math.round(sx/count), Math.round(sy/count), Math.round(sz/count)] : 'none'}`);
    if (count > 0) {
      const newPos: [number, number, number] = [Math.round(sx / count), Math.round(sy / count), Math.round(sz / count)];
      for (const sl of this.slots) {
        sl.pos = [...newPos];
        sl.viewport = computeViewport(sl.info.shape, sl.pos, this.zoomFactor);
      }
      try { this.onLabelClicked?.(maskInfo.slotIdx, label); } catch (e) { console.error("[navigate] onLabelClicked error:", e); }
      this.render();
    }
  }

  /** Navigate to next/previous label */
  navigateLesion(dir: number): void {
    const labels = this.getOverlayLabels();
    if (labels.length === 0) return;
    let idx = this.currentLabel !== null ? labels.indexOf(this.currentLabel) : -1;
    if (idx < 0) idx = 0;
    else idx = (idx + dir + labels.length) % labels.length;
    this.navigateToLabel(labels[idx]);
    this.onLabelClicked?.(this.activeSlot, labels[idx]);
    this.onStateChanged?.();
  }

  /** Toggle auto range */
  toggleAutoRange(): void {
    this.autoRange = !this.autoRange;
    if (this.autoRange) {
      this.setPercentileRange(0.01, 99.99);
    } else {
      for (const slot of this.slots) slot.imageRange = [...slot.fullRange];
    }
    this.render();
  }

  /** Set display range using percentiles (0-100). Uses sampling for speed. */
  setPercentileRange(loP: number, hiP: number): void {
    for (const slot of this.slots) {
      // Sample up to 100k values for speed
      const data = slot.data;
      const step = Math.max(1, Math.floor(data.length / 100000));
      const sampled: number[] = [];
      for (let i = 0; i < data.length; i += step) {
        if (!isNaN(data[i])) sampled.push(data[i]);
      }
      if (sampled.length === 0) continue;
      sampled.sort((a, b) => a - b);
      const lo = sampled[Math.floor(sampled.length * loP / 100)];
      const hi = sampled[Math.min(sampled.length - 1, Math.ceil(sampled.length * hiP / 100))];
      slot.imageRange = lo < hi ? [lo, hi] : [sampled[0], sampled[sampled.length - 1]];
    }
    this.render();
  }

  addImage(info: ViewerInfo, data: Float32Array): void {
    const idx = this.slots.length;
    // Sync initial position with existing slots so crosshairs land at the same location,
    // clamped to the new image's own shape bounds.
    const initPos: number[] = this.slots.length > 0
      ? this.slots[0].pos.map((p, d) => Math.max(0, Math.min((info.shape[d] ?? 1) - 1, Math.round(p))))
      : [...info.center];
    this.slots.push({
      info, data, overlays: [],
      imageRange: [...info.range],
      fullRange: [...(info.fullRange || info.range)],
      pos: initPos,
      viewport: computeViewport(info.shape, initPos, this.zoomFactor),
    });
    this.activeSlot = idx;
    if (!this.gridManual) {
      this.autoGrid();
    } else {
      // Manual mode: add to last row
      if (this.gridRows.length === 0) this.gridRows.push([idx]);
      else this.gridRows[this.gridRows.length - 1].push(idx);
    }
  }

  addOverlayToSlot(slotIdx: number, data: Float32Array, range: [number, number], shape?: [number, number, number], mode?: "filled" | "contour", cmap?: string): void {
    const slot = this.slots[slotIdx];
    if (!slot) return;
    // Detect if integer overlay and extract unique labels
    const isInteger = this.checkInteger(data);
    const labels = isInteger ? this.extractLabels(data) : [];
    const ovlShape: [number, number, number] = shape ?? (slot.info.shape as [number, number, number]);
    const isFirstOverlay = this.getAllOverlayInfo().length === 0;
    slot.overlays.push({ data, range, isInteger, labels, shape: ovlShape, mode, cmap });
    // Only set current label if this is the very first overlay
    if (isFirstOverlay && labels.length > 0) {
      this.currentLabel = labels[0];
      this.currentMaskIndex = 0;
    }
    this.showOverlay = true;
    this.render();
    this.onStateChanged?.();
  }

  private checkInteger(data: Float32Array): boolean {
    const step = Math.max(1, Math.floor(data.length / 10000));
    for (let i = 0; i < data.length; i += step) {
      const v = data[i];
      if (v !== 0 && !isNaN(v) && v !== Math.floor(v)) return false;
    }
    return true;
  }

  private extractLabels(data: Float32Array): number[] {
    const set = new Set<number>();
    for (let i = 0; i < data.length; i++) {
      const v = Math.round(data[i]);
      if (v !== 0 && !isNaN(v)) set.add(v);
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  addOverlay(data: Float32Array, range: [number, number], shape?: [number, number, number]): void {
    this.addOverlayToSlot(this.activeSlot, data, range, shape);
  }

  addOverlayToAll(data: Float32Array, range: [number, number], shape?: [number, number, number], mode?: "filled" | "contour", cmap?: string): void {
    for (let i = 0; i < this.slots.length; i++) {
      const isInteger = this.checkInteger(data);
      const labels = isInteger ? this.extractLabels(data) : [];
      const ovlShape: [number, number, number] = shape ?? (this.slots[i].info.shape as [number, number, number]);
      this.slots[i].overlays.push({ data, range, isInteger, labels, shape: ovlShape, mode, cmap });
    }
    this.showOverlay = true;
    this.render();
  }

  removeSlot(idx: number): void {
    if (this.slots.length <= 1) return;
    this.slots.splice(idx, 1);
    if (this.activeSlot >= this.slots.length) this.activeSlot = this.slots.length - 1;
    // Fix gridRows: remove idx, decrement indices > idx, remove empty rows
    this.gridRows = this.gridRows
      .map(row => row.filter(i => i !== idx).map(i => i > idx ? i - 1 : i))
      .filter(row => row.length > 0);
    if (this.gridRows.length === 0 && this.slots.length > 0) {
      this.gridRows = [this.slots.map((_, i) => i)];
    }
    this.render();
  }

  // ── Template support methods ─────────────────────────────────────

  /** Set crosshair position for all slots. Accepts NIfTI voxel coords (pre-reorientation). */
  setPosition(pos: [number, number, number]): void {
    // The viewer reorients data: axes may be permuted and flipped.
    // The reorientation info is stored in orientDebug but we don't have
    // the raw flip/perm here. Instead, use navigateToLabel-style center
    // of mass to find a nearby voxel, or just trust the coords are in
    // viewer space (post-reorientation). The server should send viewer-space coords.
    for (const slot of this.slots) {
      slot.pos = [
        Math.max(0, Math.min(slot.info.shape[0] - 1, pos[0])),
        Math.max(0, Math.min(slot.info.shape[1] - 1, pos[1])),
        Math.max(0, Math.min(slot.info.shape[2] - 1, pos[2])),
      ];
      slot.viewport = computeViewport(slot.info.shape, slot.pos, this.zoomFactor);
    }
    this.render();
  }

  /** Set grid layout explicitly (template mode). */
  setGrid(rows: number[][]): void {
    this.gridRows = rows;
    this.gridManual = true;
  }

  /** Cycle through grid layouts (every row has at least 2 panels). */
  cycleGridLayout(): void {
    const n = this.slots.length;
    if (n <= 1) return;
    const indices = this.slots.map((_, i) => i);

    const layouts: number[][][] = [];

    // Single row always included
    layouts.push([indices]);

    // Multi-row: only keep if every row has >= 2 panels
    for (let nrows = 2; nrows < n; nrows++) {
      const ncols = Math.ceil(n / nrows);
      const grid: number[][] = [];
      for (let r = 0; r < nrows; r++) {
        const row = indices.slice(r * ncols, Math.min((r + 1) * ncols, n));
        if (row.length > 0) grid.push(row);
      }
      if (grid.every(row => row.length >= 2)) {
        layouts.push(grid);
      }
    }

    const currentKey = JSON.stringify(this.gridRows);
    let idx = layouts.findIndex(l => JSON.stringify(l) === currentKey);
    idx = (idx + 1) % layouts.length;

    this.gridRows = layouts[idx];
    this.gridManual = true;
    this.render();
  }

  /** Set a custom title for a slot. */
  setSlotTitle(idx: number, title: string): void {
    const slot = this.slots[idx];
    if (slot) slot.customTitle = title;
  }

  /** Set the display range for a specific slot. */
  setSlotImageRange(idx: number, range: [number, number]): void {
    const slot = this.slots[idx];
    if (slot) slot.imageRange = range;
  }

  /** Set the image colormap (index 0). */
  setImageColormap(cmap: string): void {
    this.imageColormaps[0] = cmap;
  }

  /** Set the overlay colormap (index 0). */
  setOverlayColormap(cmap: string): void {
    this.overlayColormaps[0] = cmap;
  }

  /** Get the overlay label value at screen coordinates (mx, my). Returns 0 if no overlay. */
  getLabelAtScreenPos(mx: number, my: number): { slotIdx: number; label: number } | null {
    for (const r of this.regions) {
      if (mx < r.dx || mx >= r.dx + r.dw || my < r.dy || my >= r.dy + r.dh) continue;
      const slot = this.slots[r.slotIdx];
      if (!slot || slot.overlays.length === 0) continue;

      // Same mapping as ptr() → setPosAllSlots()
      const vx = Math.round((mx - r.dx) / r.scaleX);
      const vy = Math.round((my - r.dy) / r.scaleY);
      const vp = slot.viewport;
      const s = slot.info.shape;
      const cl = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));

      let vi: number, vj: number, vk: number;
      switch (r.view) {
        case "axial":
          vi = cl(vp[0][0] + vx, s[0]);
          vj = cl(vp[1][0] + vy, s[1]);
          vk = slot.pos[2];
          break;
        case "coronal":
          vi = cl(vp[0][0] + vx, s[0]);
          vj = slot.pos[1];
          vk = cl(vp[2][0] + vy, s[2]);
          break;
        case "sagittal":
          vi = slot.pos[0];
          vj = cl(vp[1][0] + vx, s[1]);
          vk = cl(vp[2][0] + vy, s[2]);
          break;
        default: continue;
      }

      const ovl = slot.overlays[0];
      const idx = vi * s[1] * s[2] + vj * s[2] + vk;
      const label = Math.round(ovl.data[idx]);
      if (label > 0) return { slotIdx: r.slotIdx, label };
    }
    return null;
  }

  /** Callback when user double-clicks on an overlay label */
  onLabelClicked?: (slotIdx: number, label: number) => void;

  init(): void {
    this.resize();
    this.setupEvents();
    this.renderNow();
    this.ro = new ResizeObserver(() => { this.resize(); this.renderNow(); });
    this.ro.observe(this.container);
  }

  destroy(): void { this.ro?.disconnect(); this.container.innerHTML = ""; }

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    const w = Math.round(r.width * this.dpr);
    const h = Math.round(r.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  private get cw(): number { return Math.round(this.canvas.width / this.dpr); }
  private get ch(): number { return Math.round(this.canvas.height / this.dpr); }

  // ── Layout ────────────────────────────────────────────────────────

  /**
   * Layout using explicit gridRows. Each row can have different number of columns.
   */
  private layout(): ViewRegion[] {
    const cw = this.cw, ch = this.ch, g = 4;
    const titleH = 18; // reserved height for title bar
    const regions: ViewRegion[] = [];
    const nRows = this.gridRows.length || 1;
    const rowH = Math.floor((ch - g * (nRows - 1)) / nRows);

    // Use max column count so shorter rows align with columns above
    const maxCols = Math.max(...this.gridRows.map(row => row.length), 1);
    const cellW = Math.floor((cw - g * (maxCols - 1)) / maxCols);

    for (let r = 0; r < this.gridRows.length; r++) {
      const row = this.gridRows[r];
      const y0 = r * (rowH + g) + titleH;
      const contentH = rowH - titleH;

      for (let c = 0; c < row.length; c++) {
        const s = row[c];
        const slot = this.slots[s];
        if (!slot) continue;
        const x0 = c * (cellW + g);

        if (this.view === "multiplanar") {
          const others = SINGLE_VIEWS.filter(v => v !== this.mainMultiView);
          const mid = Math.round(cellW * 0.5);
          const hMid = Math.round(contentH * 0.5);
          regions.push(this.fit(s, slot, this.mainMultiView, x0, y0, mid - g, contentH));
          regions.push(this.fit(s, slot, others[0], x0 + mid + g, y0, cellW - mid - g, hMid - g));
          regions.push(this.fit(s, slot, others[1], x0 + mid + g, y0 + hMid + g, cellW - mid - g, contentH - hMid - g));
        } else {
          regions.push(this.fit(s, slot, this.view as SingleView, x0, y0, cellW, contentH));
        }
      }
    }
    return regions;
  }

  private fit(slotIdx: number, slot: ImageSlot, view: SingleView, rx: number, ry: number, rw: number, rh: number): ViewRegion {
    const vp = slot.viewport;
    let sw: number, sh: number;
    switch (view) {
      case "axial":    sw = vp[0][1] - vp[0][0]; sh = vp[1][1] - vp[1][0]; break;
      case "sagittal": sw = vp[1][1] - vp[1][0]; sh = vp[2][1] - vp[2][0]; break;
      case "coronal":  sw = vp[0][1] - vp[0][0]; sh = vp[2][1] - vp[2][0]; break;
    }
    if (sw <= 0 || sh <= 0) return { view, slotIdx, dx: rx, dy: ry, dw: 0, dh: 0, sliceW: 0, sliceH: 0, scaleX: 1, scaleY: 1 };
    const ar = getAspectRatio(slot.info.voxelSizes, view);
    const scale = Math.min(rw / sw, rh / (sh * ar));
    const dw = sw * scale, dh = sh * ar * scale;
    const dx = rx + (rw - dw) / 2, dy = ry + (rh - dh) / 2;
    return { view, slotIdx, dx, dy, dw, dh, sliceW: sw, sliceH: sh, scaleX: dw / sw, scaleY: dh / sh };
  }

  // ── Render ────────────────────────────────────────────────────────

  /** Throttled render — coalesces multiple render() calls into one frame. */
  render(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.renderNow();
    });
  }

  /** Immediate render — use sparingly (e.g. init, resize). */
  renderNow(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.cw, this.ch);

    this.regions = this.layout();
    for (const r of this.regions) this.renderRegion(r);

    // Column titles (once per slot, not per plane)
    this.drawColumnTitles();

    this.drawDebugInfo();
    if (this.slots.length > 1) this.drawCloseButtons();
    this.drawDropIndicator();
  }

  private renderRegion(r: ViewRegion): void {
    const ctx = this.ctx;
    const slot = this.slots[r.slotIdx];
    if (!slot) return;
    const { view, dx, dy, dw, dh, sliceW, sliceH, scaleX, scaleY } = r;
    if (sliceW <= 0 || sliceH <= 0) return;

    // Image
    const slice = extractSlice(slot.data, slot.info.shape, view, slot.pos, slot.viewport);
    const lut = getLUT(this.imageColormaps[0] || "gray");
    const imgd = renderSliceToImageData(slice.data, slice.width, slice.height, lut, slot.imageRange[0], slot.imageRange[1]);
    this.tmp.width = sliceW; this.tmp.height = sliceH;
    this.tmpCtx.putImageData(imgd, 0, 0);
    ctx.imageSmoothingEnabled = this.smoothInterp;
    ctx.drawImage(this.tmp, dx, dy, dw, dh);

    // Overlay
    if (slot.overlays.length > 0 && this.showOverlay) {
      const ovl = slot.overlays[0];
      const ovlSlice = extractSlice(ovl.data, slot.info.shape, view, slot.pos, slot.viewport);
      const ovlLut = getLUT(ovl.cmap || this.overlayColormaps[0] || "rainbow");
      let ovlData = ovlSlice.data;
      // Determine contour mode: per-overlay mode, cycle state, or legacy global toggle
      let useContour: boolean;
      if (this.contourCycleState === "all-contour") {
        useContour = true;
      } else if (this.contourCycleState === "all-filled") {
        useContour = false;
      } else if (ovl.mode !== undefined) {
        useContour = ovl.mode === "contour";
      } else {
        useContour = this.showContour;
      }
      if (useContour && ovl.isInteger) ovlData = findBoundaries(ovlData, ovlSlice.width, ovlSlice.height);
      const ovlImgd = renderOverlayToImageData(ovlData, ovlSlice.width, ovlSlice.height, ovlLut, ovl.range[0], ovl.range[1], this.alpha);
      const otmp = document.createElement("canvas");
      otmp.width = sliceW; otmp.height = sliceH;
      otmp.getContext("2d")!.putImageData(ovlImgd, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(otmp, dx, dy, dw, dh);
    }

    // Crosshairs
    if (this.showCrosshairs) {
      const cp = getCrosshairPos(view, slot.viewport, slot.pos);
      const cx = dx + (cp[0] + 0.5) * scaleX;
      const cy = dy + (cp[1] + 0.5) * scaleY;

      ctx.save();
      ctx.strokeStyle = this.crosshairColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.globalAlpha = 0.85;
      if (this.fullCrosshairs) {
        ctx.beginPath(); ctx.moveTo(cx, dy); ctx.lineTo(cx, dy + dh); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(dx, cy); ctx.lineTo(dx + dw, cy); ctx.stroke();
      } else {
        const gap = 10 * Math.min(scaleX, scaleY);
        ctx.beginPath(); ctx.moveTo(cx, dy); ctx.lineTo(cx, cy - gap); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, dy + dh); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(dx, cy); ctx.lineTo(cx - gap, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx + gap, cy); ctx.lineTo(dx + dw, cy); ctx.stroke();
      }
      ctx.restore();

      // Show value on the main view (single view or the large panel in multiplanar)
      if (this.view !== "multiplanar" || view === this.mainMultiView) {
        let val = this.voxelVal(slot.data, slot);
        if (slot.overlays.length > 0 && this.showOverlay) {
          val += ` (${this.voxelVal(slot.overlays[0].data, slot)})`;
        }
        ctx.save();
        ctx.font = "bold 13px monospace";
        ctx.textAlign = "right"; ctx.textBaseline = "bottom";
        ctx.strokeStyle = "#000"; ctx.lineWidth = 3;
        ctx.strokeText(val, dx + dw - 6, dy + dh - 5);
        ctx.fillStyle = this.crosshairColor;
        ctx.fillText(val, dx + dw - 6, dy + dh - 5);
        ctx.restore();
      }

      this.drawLabels(r);
    }
  }

  /** Find row/col for a slot index within gridRows */
  private slotGridPos(slotIdx: number): { row: number; col: number; nCols: number } | null {
    for (let r = 0; r < this.gridRows.length; r++) {
      const c = this.gridRows[r].indexOf(slotIdx);
      if (c >= 0) return { row: r, col: c, nCols: this.gridRows[r].length };
    }
    return null;
  }

  private drawColumnTitles(): void {
    const ctx = this.ctx;
    for (let s = 0; s < this.slots.length; s++) {
      const r = this.slotCellRect(s);
      if (r.w === 0) continue;
      const name = this.slots[s].customTitle || this.slots[s].info.filename;
      ctx.save();
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillStyle = s === this.activeSlot ? "#7af" : "#667";
      ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
      const label = name.length > 35 ? name.slice(-35) : name;
      ctx.strokeText(label, r.x + r.w / 2, r.y + 4);
      ctx.fillText(label, r.x + r.w / 2, r.y + 4);
      ctx.restore();
    }
  }

  private drawLabels(r: ViewRegion): void {
    const ctx = this.ctx;
    const { view, dx, dy, dw, dh } = r;
    const L = ORI[view]; if (!L) return;
    const fs = 15;
    ctx.save();
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.fillStyle = "#fc0"; ctx.strokeStyle = "#000"; ctx.lineWidth = 2.5;
    const draw = (t: string, x: number, y: number, al: CanvasTextAlign, bl: CanvasTextBaseline) => {
      ctx.textAlign = al; ctx.textBaseline = bl; ctx.strokeText(t, x, y); ctx.fillText(t, x, y);
    };
    draw(L[0], dx + dw / 2, dy + fs + 2, "center", "top");
    draw(L[1], dx + dw / 2, dy + dh - 5, "center", "bottom");
    draw(L[2], dx + 8, dy + dh / 2, "left", "middle");
    draw(L[3], dx + dw - 8, dy + dh / 2, "right", "middle");
    ctx.restore();
  }

  private drawDebugInfo(): void {
    const ctx = this.ctx;
    const slot = this.slots[this.activeSlot]; if (!slot) return;
    const s = slot.info.shape, vs = slot.info.voxelSizes;
    const dimStr = `${s[0]}\u00D7${s[1]}\u00D7${s[2]}  ${vs[0].toFixed(1)}\u00D7${vs[1].toFixed(1)}\u00D7${vs[2].toFixed(1)}mm`;
    const voxStr = `Voxel: [${slot.pos[0]}, ${slot.pos[1]}, ${slot.pos[2]}]`;
    ctx.save(); ctx.font = "11px monospace";
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(200,200,200,0.6)";
    ctx.fillText(dimStr, 8, this.ch - 18);
    ctx.fillText(voxStr, 8, this.ch - 6);
    ctx.restore();
  }

  private drawCloseButtons(): void {
    const ctx = this.ctx;
    for (let s = 0; s < this.slots.length; s++) {
      const cr = this.closeRect(s);
      if (!cr) continue;
      const bx = cr.x, by = cr.y, sz = cr.w;
      ctx.save();
      ctx.strokeStyle = "#ccc"; ctx.lineWidth = 1.5;
      const m = 4;
      ctx.beginPath();
      ctx.moveTo(bx+m, by+m); ctx.lineTo(bx+sz-m, by+sz-m);
      ctx.moveTo(bx+sz-m, by+m); ctx.lineTo(bx+m, by+sz-m);
      ctx.stroke(); ctx.restore();
    }

  }

  // ── Hit testing helpers ─────────────────────────────────────────

  private titleRect(slotIdx: number): { x: number; y: number; w: number; h: number } | null {
    const r = this.slotCellRect(slotIdx);
    if (r.w === 0) return null;
    return { x: r.x, y: r.y, w: this.slots.length > 1 ? r.w - 26 : r.w, h: 18 };
  }

  private closeRect(slotIdx: number): { x: number; y: number; w: number; h: number } | null {
    if (this.slots.length <= 1) return null;
    const r = this.slotCellRect(slotIdx);
    if (r.w === 0) return null;
    return { x: r.x + r.w - 22, y: r.y + 4, w: 16, h: 16 };
  }

  private slotCellRect(slotIdx: number): { x: number; y: number; w: number; h: number } {
    const g = 4;
    const nRows = this.gridRows.length || 1;
    const rowH = Math.floor((this.ch - g * (nRows - 1)) / nRows);
    const pos = this.slotGridPos(slotIdx);
    if (!pos) return { x: 0, y: 0, w: 0, h: 0 };
    const maxCols = Math.max(...this.gridRows.map(row => row.length), 1);
    const cellW = Math.floor((this.cw - g * (maxCols - 1)) / maxCols);
    return { x: pos.col * (cellW + g), y: pos.row * (rowH + g), w: cellW, h: rowH };
  }

  /** Find the drop zone for the current drag position */
  private computeDropZone(mx: number, my: number): { slot: number; side: "left" | "right" | "top" | "bottom" | "swap" } | null {
    for (let s = 0; s < this.slots.length; s++) {
      if (s === this.slotDragIdx) continue;
      const r = this.slotCellRect(s);
      if (mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h) {
        const relY = (my - r.y) / r.h;
        const relX = (mx - r.x) / r.w;
        // Center zone: swap in place
        if (relY >= 0.25 && relY <= 0.75 && relX >= 0.25 && relX <= 0.75) {
          return { slot: s, side: "swap" };
        }
        // Edge zones: insert left/right/top/bottom
        if (relY < 0.25) return { slot: s, side: "top" };
        if (relY > 0.75) return { slot: s, side: "bottom" };
        if (relX < 0.5) return { slot: s, side: "left" };
        return { slot: s, side: "right" };
      }
    }
    return null;
  }

  // ── Drag reorder rendering ────────────────────────────────────

  private drawDropIndicator(): void {
    if (!this.slotDragging || !this.dropZone) return;
    const ctx = this.ctx;
    const r = this.slotCellRect(this.dropZone.slot);
    const thick = 4;

    ctx.save();
    ctx.fillStyle = "rgba(100,160,255,0.25)";
    switch (this.dropZone.side) {
      case "top":
        ctx.fillRect(r.x, r.y, r.w, thick);
        break;
      case "bottom":
        ctx.fillRect(r.x, r.y + r.h - thick, r.w, thick);
        break;
      case "left":
        ctx.fillRect(r.x, r.y, thick, r.h);
        break;
      case "right":
        ctx.fillRect(r.x + r.w - thick, r.y, thick, r.h);
        break;
      case "swap":
        ctx.fillRect(r.x, r.y, r.w, r.h);
        break;
    }

    // Also draw a subtle highlight on the whole zone
    ctx.strokeStyle = "#7af";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    switch (this.dropZone.side) {
      case "top":    ctx.strokeRect(r.x + 1, r.y, r.w - 2, r.h / 2); break;
      case "bottom": ctx.strokeRect(r.x + 1, r.y + r.h / 2, r.w - 2, r.h / 2); break;
      case "left":   ctx.strokeRect(r.x, r.y + 1, r.w / 2, r.h - 2); break;
      case "right":  ctx.strokeRect(r.x + r.w / 2, r.y + 1, r.w / 2, r.h - 2); break;
      case "swap":   ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2); break;
    }
    ctx.restore();

    // Ghost title
    if (this.slotDragIdx >= 0 && this.slotDragIdx < this.slots.length) {
      const s = this.slots[this.slotDragIdx];
      const name = s.customTitle || s.info.filename;
      const label = name.length > 30 ? name.slice(-30) : name;
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "#7af";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, this.slotDragMx, this.slotDragMy);
      ctx.restore();
    }
  }

  // ── Interaction ───────────────────────────────────────────────────

  // Touch pinch state
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  private pinching = false;

  private setupEvents(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointerleave", () => { this.dragging = false; this.cancelSlotDrag(); });
    c.addEventListener("dblclick", (e) => this.onDblClick(e));
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    c.addEventListener("touchstart", (e) => this.onTouchStart(e), { passive: false });
    c.addEventListener("touchmove", (e) => this.onTouchMove(e), { passive: false });
    c.addEventListener("touchend", () => { this.pinching = false; });
    c.setAttribute("tabindex", "0");
    c.addEventListener("keydown", (e) => this.onKey(e));
    c.focus();
  }

  private touchDist(e: TouchEvent): number {
    const t0 = e.touches[0], t1 = e.touches[1];
    const dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 2) {
      e.preventDefault();
      this.pinching = true;
      this.pinchStartDist = this.touchDist(e);
      this.pinchStartZoom = this.zoomFactor;
    }
  }

  private onTouchMove(e: TouchEvent): void {
    if (this.pinching && e.touches.length === 2) {
      e.preventDefault();
      const dist = this.touchDist(e);
      const scale = dist / this.pinchStartDist;
      this.zoomFactor = Math.max(1, Math.min(15, this.pinchStartZoom * scale));
      this.updateAllViewports();
      this.render();
    }
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.canvas.focus();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    if (this.slots.length > 1) {
      // Close buttons
      for (let s = 0; s < this.slots.length; s++) {
        const cr = this.closeRect(s);
        if (cr && mx >= cr.x && mx <= cr.x + cr.w && my >= cr.y && my <= cr.y + cr.h) {
          this.removeSlot(s); this.onStateChanged?.(); return;
        }
      }
    }
    // Title click: delay drag start to allow dblclick to intercept
    for (let s = 0; s < this.slots.length; s++) {
      const tr = this.titleRect(s);
      if (tr && mx >= tr.x && mx <= tr.x + tr.w && my >= tr.y && my <= tr.y + tr.h) {
        if (this.slots.length > 1) {
          this.cancelPendingDrag();
          this.pendingDragSlot = s;
          this.pendingDragMx = mx;
          this.pendingDragMy = my;
          this.pendingDragTimer = setTimeout(() => {
            this.slotDragging = true;
            this.slotDragIdx = this.pendingDragSlot;
            this.slotDragMx = this.pendingDragMx;
            this.slotDragMy = this.pendingDragMy;
            this.pendingDragTimer = null;
            this.canvas.style.cursor = "grabbing";
          }, 200);
        }
        return; // absorb the click either way (no crosshair move on title)
      }
    }
    this.dragging = true;
    this.dragLastY = e.clientY;
  }

  private onDblClick(e: MouseEvent): void {
    // Cancel any pending single-click crosshair movement
    if (this.pendingClickTimer) {
      clearTimeout(this.pendingClickTimer);
      this.pendingClickTimer = null;
      this.pendingClickEvent = null;
    }

    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    for (let s = 0; s < this.slots.length; s++) {
      const tr = this.titleRect(s);
      if (tr && mx >= tr.x && mx <= tr.x + tr.w && my >= tr.y && my <= tr.y + tr.h) {
        this.cancelPendingDrag();
        this.cancelSlotDrag();
        this.dragging = false;
        this.openTitleEditor(s);
        return;
      }
    }

    // Check if double-clicked on an overlay label
    const hit = this.getLabelAtScreenPos(mx, my);
    if (hit && hit.label > 0) {
      this.onLabelClicked?.(hit.slotIdx, hit.label);
    }
  }

  private cancelPendingDrag(): void {
    if (this.pendingDragTimer) {
      clearTimeout(this.pendingDragTimer);
      this.pendingDragTimer = null;
    }
    this.pendingDragSlot = -1;
  }

  private openTitleEditor(slotIdx: number): void {
    if (this.activeEditInput) this.closeTitleEditor(false);

    const slot = this.slots[slotIdx];
    if (!slot) return;
    const cellRect = this.slotCellRect(slotIdx);
    if (cellRect.w === 0) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "title-edit-input";
    input.value = slot.customTitle || slot.info.filename;
    input.style.left = `${cellRect.x}px`;
    input.style.top = `${cellRect.y + 1}px`;
    input.style.width = `${this.slots.length > 1 ? cellRect.w - 26 : cellRect.w}px`;
    this.activeEditInput = input;

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      slot.customTitle = val && val !== slot.info.filename ? val : undefined;
      this.closeTitleEditor(false);
      this.render();
      this.onStateChanged?.();
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); committed = true; this.closeTitleEditor(false); }
      ev.stopPropagation(); // prevent viewer hotkeys
    });
    input.addEventListener("blur", () => commit());

    this.container.appendChild(input);
    input.focus();
    input.select();
  }

  private closeTitleEditor(save: boolean): void {
    if (!this.activeEditInput) return;
    // Remove blur listener before removing to avoid double-commit
    const input = this.activeEditInput;
    this.activeEditInput = null;
    input.remove();
  }

  private onMove(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // Slot drag
    if (this.slotDragging) {
      this.slotDragMx = mx;
      this.slotDragMy = my;
      this.dropZone = this.computeDropZone(mx, my);
      this.render();
      return;
    }

    // Normal drag
    if (this.dragging) {
      if (this.dragScrollMode) {
        const deltaY = e.clientY - this.dragLastY;
        const sliceDelta = Math.round(-deltaY / 10);
        if (sliceDelta !== 0) {
          this.scrollAll(sliceDelta);
          this.dragLastY = e.clientY;
        }
      } else {
        this.ptr(e, true);
      }
      return;
    }

    // Cursor updates (hover)
    this.updateCursor(mx, my);
  }

  private onUp(e: PointerEvent): void {
    // Slot drag drop
    if (this.slotDragging) {
      this.finishSlotDrag();
      return;
    }

    if (this.dragging && !this.dragScrollMode) {
      // Delay crosshair move to allow double-click to cancel it
      if (this.pendingClickTimer) clearTimeout(this.pendingClickTimer);
      this.pendingClickEvent = e;
      this.pendingClickTimer = setTimeout(() => {
        if (this.pendingClickEvent) {
          this.ptr(this.pendingClickEvent, false);
          this.pendingClickEvent = null;
        }
        this.pendingClickTimer = null;
      }, 20);
    }
    this.dragging = false;
  }

  private updateCursor(mx: number, my: number): void {
    for (let s = 0; s < this.slots.length; s++) {
      if (this.slots.length > 1) {
        const cr = this.closeRect(s);
        if (cr && mx >= cr.x && mx <= cr.x + cr.w && my >= cr.y && my <= cr.y + cr.h) {
          this.canvas.style.cursor = "default";
          return;
        }
      }
      const tr = this.titleRect(s);
      if (tr && mx >= tr.x && mx <= tr.x + tr.w && my >= tr.y && my <= tr.y + tr.h) {
        this.canvas.style.cursor = this.slots.length > 1 ? "grab" : "text";
        return;
      }
    }
    this.canvas.style.cursor = this.dragScrollMode ? "ns-resize" : "crosshair";
  }

  private finishSlotDrag(): void {
    const fromIdx = this.slotDragIdx;
    const zone = this.dropZone;
    this.slotDragging = false;
    this.slotDragIdx = -1;
    this.dropZone = null;
    this.canvas.style.cursor = "crosshair";

    if (fromIdx < 0 || !zone) { this.render(); return; }

    const toIdx = zone.slot;
    if (fromIdx === toIdx) { this.render(); return; }

    if (zone.side === "swap") {
      // Swap the two slots in place within gridRows
      for (const row of this.gridRows) {
        for (let i = 0; i < row.length; i++) {
          if (row[i] === fromIdx) row[i] = toIdx;
          else if (row[i] === toIdx) row[i] = fromIdx;
        }
      }
    } else {
      // Remove fromIdx from its current position in gridRows
      for (const row of this.gridRows) {
        const i = row.indexOf(fromIdx);
        if (i >= 0) { row.splice(i, 1); break; }
      }

      // Find target position
      const targetPos = this.slotGridPos(toIdx);
      if (!targetPos) { this.rebuildGrid(); this.render(); return; }

      switch (zone.side) {
        case "left": {
          const row = this.gridRows[targetPos.row];
          const i = row.indexOf(toIdx);
          row.splice(i, 0, fromIdx);
          break;
        }
        case "right": {
          const row = this.gridRows[targetPos.row];
          const i = row.indexOf(toIdx);
          row.splice(i + 1, 0, fromIdx);
          break;
        }
        case "top": {
          this.gridRows.splice(targetPos.row, 0, [fromIdx]);
          break;
        }
        case "bottom": {
          this.gridRows.splice(targetPos.row + 1, 0, [fromIdx]);
          break;
        }
      }
    }

    // Clean up empty rows
    this.gridRows = this.gridRows.filter(row => row.length > 0);
    this.gridManual = true;
    this.onStateChanged?.();
    this.render();
  }

  /** Rebuild gridRows from slots (fallback) */
  private rebuildGrid(): void {
    this.gridRows = [this.slots.map((_, i) => i)];
  }

  /** NiiVue-style auto grid: try all row counts, pick largest cell size */
  private autoGrid(): void {
    const n = this.slots.length;
    if (n === 0) { this.gridRows = []; return; }
    const cw = this.cw || 800, ch = this.ch || 600, g = 4;

    let bestCols = n, bestRows = 1, bestSize = 0;
    for (let nrows = 1; nrows <= n; nrows++) {
      const ncols = Math.ceil(n / nrows);
      const cellW = Math.floor(cw / ncols - g);
      const cellH = Math.floor(ch / nrows - g);
      const size = Math.min(cellW, cellH);
      if (size > bestSize) { bestSize = size; bestCols = ncols; bestRows = nrows; }
    }

    this.gridRows = [];
    let idx = 0;
    for (let r = 0; r < bestRows && idx < n; r++) {
      const row: number[] = [];
      for (let c = 0; c < bestCols && idx < n; c++) {
        row.push(idx++);
      }
      this.gridRows.push(row);
    }
  }

  private cancelSlotDrag(): void {
    this.cancelPendingDrag();
    this.slotDragging = false;
    this.slotDragIdx = -1;
    this.dropZone = null;
    this.dragging = false;
  }

  private ptr(e: PointerEvent, noPan: boolean): void {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    for (const r of this.regions) {
      if (mx >= r.dx && mx < r.dx + r.dw && my >= r.dy && my < r.dy + r.dh) {
        const slot = this.slots[r.slotIdx];
        if (!slot) return;
        this.activeSlot = r.slotIdx;
        this.focusedView = r.view;

        const vx = Math.round((mx - r.dx) / r.scaleX);
        const vy = Math.round((my - r.dy) / r.scaleY);
        this.setPosAllSlots(r.view, vx, vy, slot.viewport, noPan);
        return;
      }
    }
  }

  /** Sync crosshair position across all images. noPan=true skips viewport recenter (for drag). */
  private setPosAllSlots(view: SingleView, vx: number, vy: number, sourceVp: Viewport, noPan = false): void {
    const cl = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));

    for (const slot of this.slots) {
      const s = slot.info.shape;
      switch (view) {
        case "axial":
          slot.pos[0] = cl(sourceVp[0][0] + vx, s[0]);
          slot.pos[1] = cl(sourceVp[1][0] + vy, s[1]);
          break;
        case "sagittal":
          slot.pos[1] = cl(sourceVp[1][0] + vx, s[1]);
          slot.pos[2] = cl(sourceVp[2][0] + vy, s[2]);
          break;
        case "coronal":
          slot.pos[0] = cl(sourceVp[0][0] + vx, s[0]);
          slot.pos[2] = cl(sourceVp[2][0] + vy, s[2]);
          break;
      }
      if (!noPan) {
        slot.viewport = computeViewport(slot.info.shape, slot.pos, this.zoomFactor);
      }
    }
    this.render();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let matched = false;
    for (const r of this.regions) {
      if (mx >= r.dx && mx < r.dx + r.dw && my >= r.dy && my < r.dy + r.dh) {
        this.activeSlot = r.slotIdx;
        this.focusedView = r.view;
        matched = true;
        break;
      }
    }
    // Fallback: cursor is in a gap/padding between panels — pick the nearest region
    // so scrolling always acts on the closest panel, not some stale focusedView.
    if (!matched && this.regions.length > 0) {
      let best = this.regions[0];
      let bestDist = Infinity;
      for (const r of this.regions) {
        const cx = r.dx + r.dw / 2, cy = r.dy + r.dh / 2;
        const dist = (mx - cx) ** 2 + (my - cy) ** 2;
        if (dist < bestDist) { bestDist = dist; best = r; }
      }
      this.activeSlot = best.slotIdx;
      this.focusedView = best.view;
    }

    // Pinch-to-zoom: ctrlKey (Chromium trackpad pinch + Ctrl+scroll) or Alt+scroll
    if (e.ctrlKey || e.altKey) {
      const delta = -e.deltaY * (e.ctrlKey ? 0.01 : 0.05);
      this.zoomFactor = Math.max(1, Math.min(15, this.zoomFactor + delta));
      this.updateAllViewports();
      this.render();
      this.onStateChanged?.();
    } else {
      this.scrollAll(e.deltaY > 0 ? -1 : 1);
    }
  }

  /** Scroll all images on the same axis */
  private scrollAll(dir: number): void {
    const dim: Record<SingleView, number> = { axial: 2, sagittal: 0, coronal: 1 };
    const d = dim[this.focusedView];
    for (const slot of this.slots) {
      slot.pos[d] = Math.max(0, Math.min(slot.info.shape[d] - 1, slot.pos[d] + dir));
      slot.viewport = computeViewport(slot.info.shape, slot.pos, this.zoomFactor);
    }
    this.render();
  }

  private onKey(e: KeyboardEvent): void {
    // Ctrl+Shift+C: copy canvas to clipboard
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "C") {
      e.preventDefault();
      this.canvas.toBlob((blob) => {
        if (blob) {
          navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(
            () => { this.showToast("Copied to clipboard"); },
            () => { this.showToast("Clipboard not available in webview"); }
          );
        }
      }, "image/png");
      return;
    }
    // Let browser handle other Cmd/Ctrl combos (reload, copy, paste, etc.)
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    switch (e.key) {
      case "V": case "v": {
        const idx = VIEW_CYCLE.indexOf(this.view);
        this.view = VIEW_CYCLE[(idx + 1) % VIEW_CYCLE.length];
        if (this.view !== "multiplanar") this.focusedView = this.view as SingleView;
        this.onStateChanged?.(); break;
      }
      case "G": case "g": {
        // Cycle the main (large) view in multiplanar
        const idx = SINGLE_VIEWS.indexOf(this.mainMultiView);
        this.mainMultiView = SINGLE_VIEWS[(idx + 1) % SINGLE_VIEWS.length];
        this.onStateChanged?.(); break;
      }
      case "A": this.view = "axial"; this.focusedView = "axial"; this.onStateChanged?.(); break;
      case "C": this.view = "coronal"; this.focusedView = "coronal"; this.onStateChanged?.(); break;
      case "S": this.view = "sagittal"; this.focusedView = "sagittal"; this.onStateChanged?.(); break;
      case "M": this.view = "multiplanar"; this.onStateChanged?.(); break;
      case "F": this.onAddImageRequest?.(); return;
      case "O": this.onAddOverlayRequest?.(); return;
      case "f": this.fullCrosshairs = !this.fullCrosshairs; break;
      case "r": this.toggleAutoRange(); this.onStateChanged?.(); return;
      case "R": this.resetOverlayRange(); this.onStateChanged?.(); return;
      case "x": this.showCrosshairs = !this.showCrosshairs; break;
      case "i": this.smoothInterp = !this.smoothInterp; break;
      case "w": this.showOverlay = !this.showOverlay; break;
      case "c": {
        // Cycle: template → all-contour → all-filled → template
        const cycle: Array<"template" | "all-contour" | "all-filled"> = ["template", "all-contour", "all-filled"];
        const ci = cycle.indexOf(this.contourCycleState);
        this.contourCycleState = cycle[(ci + 1) % cycle.length];
        // Keep showContour in sync for backwards compat (legacy global toggle)
        this.showContour = this.contourCycleState === "all-contour";
        break;
      }
      case "n": this.navigateLesion(1); return;
      case "p": this.navigateLesion(-1); return;
      case "l": this.cycleGridLayout(); this.onStateChanged?.(); return;
      case "d":
        this.dragScrollMode = !this.dragScrollMode;
        this.container.classList.toggle("drag-scroll", this.dragScrollMode);
        this.onStateChanged?.(); break;
      case "+": case "=": this.zoomFactor = Math.min(this.zoomFactor + 0.5, 15); break;
      case "-": this.zoomFactor = Math.max(this.zoomFactor - 0.5, 1); break;
      case "0": this.zoomFactor = 1; break;
      case "j": this.scrollAll(-1); return;
      case "k": this.scrollAll(1); return;
      case "q": this.alpha = Math.max(0, this.alpha - 0.1); break;
      case "e": this.alpha = Math.min(1, this.alpha + 0.1); break;
      case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight":
      case "PageUp": case "PageDown":
        this.handleArrowKey(e.key); return;
      case "Tab":
        if (this.slots.length > 1) this.activeSlot = (this.activeSlot + 1) % this.slots.length;
        break;
      default: return;
    }
    this.updateAllViewports();
    this.render();
  }

  /** Arrow keys move within the current slice plane, PageUp/Down change slices (like viewer-ts) */
  private handleArrowKey(key: string): void {
    const mapping: Record<SingleView, Record<string, [number, number]>> = {
      // [dimension, delta] — screen direction matches crosshair movement
      axial: {
        ArrowUp: [1, -1], ArrowDown: [1, 1],
        ArrowLeft: [0, -1], ArrowRight: [0, 1],
        PageUp: [2, -1], PageDown: [2, 1],
      },
      coronal: {
        ArrowUp: [2, -1], ArrowDown: [2, 1],
        ArrowLeft: [0, -1], ArrowRight: [0, 1],
        PageUp: [1, -1], PageDown: [1, 1],
      },
      sagittal: {
        ArrowUp: [2, -1], ArrowDown: [2, 1],
        ArrowLeft: [1, -1], ArrowRight: [1, 1],
        PageUp: [0, -1], PageDown: [0, 1],
      },
    };
    const m = mapping[this.focusedView];
    if (!m || !m[key]) return;
    const [dim, delta] = m[key];
    for (const slot of this.slots) {
      slot.pos[dim] = Math.max(0, Math.min(slot.info.shape[dim] - 1, slot.pos[dim] + delta));
      slot.viewport = computeViewport(slot.info.shape, slot.pos, this.zoomFactor);
    }
    this.render();
  }

  private updateAllViewports(): void {
    for (const slot of this.slots) slot.viewport = computeViewport(slot.info.shape, slot.pos, this.zoomFactor);
  }

  private voxelVal(data: Float32Array, slot: ImageSlot): string {
    const [, D1, D2] = slot.info.shape;
    const idx = slot.pos[0] * D1 * D2 + slot.pos[1] * D2 + slot.pos[2];
    const v = (idx >= 0 && idx < data.length) ? data[idx] : 0;
    if (v === 0) return "0";
    if (Number.isInteger(v)) return String(v);
    return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
  }
}
