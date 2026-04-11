// ════════════════════════════════════════════════════════════════════════
//  NiftiViewer class
// ════════════════════════════════════════════════════════════════════════

import type {
    ViewerConfig, ViewType, SingleView, Viewport, Volumes, Panel,
    ViewRegion, ViewerControls, AnyWidgetModel, ClassificationData,
    BoundingBox,
} from "./types";
import { getLUT } from "./colormaps";
import { getSliceDims, extractSlice, findBoundaries } from "./slicing";
import {
    renderSliceToImageData, renderOverlayToImageData,
    getAspectRatio, getCrosshairPos, computeViewport, ANAT_LABELS,
} from "./rendering";
import { createElement, createSlider, createRangeSlider, createDropdown, createCheckbox, createButton } from "./controls";

export class NiftiViewer {
    container: HTMLElement;
    config: ViewerConfig;
    volumes: Volumes;
    images_string: string | null;
    overlays_string: string | null;

    // State
    pos: number[];
    posRas: number[];
    view: ViewType;
    zoomFactor: number;
    alpha: number;
    showOverlay: boolean;
    showContour: boolean;
    showCrosshairs: boolean;
    fullCrosshairs: boolean;
    showBoundingBox: boolean;
    crosshairColor: string;
    imageColormaps: string[];
    overlayColormaps: string[];
    percentile: number;
    percentileLo: number;
    autoRange: boolean;
    focusedView: SingleView;
    bboxMargin: number;
    caption: string | null;
    smoothInterp: boolean;

    _zoomScale: number;
    _sizeScale!: number;
    _basePanelW!: number;

    imageRanges: [number, number][];
    overlayRanges: ([number, number] | null)[];
    viewport: Viewport;
    boundingBox: BoundingBox | null;

    currentMaskIndex: number;
    currentLesionIndex: number | null;
    lesionLabels: number[];

    classificationData: ClassificationData | null;
    classificationOptions: string[];
    classificationFile: string;

    pressedKeys: Set<string>;
    panels: Panel[];
    controls: Partial<ViewerControls>;

    _tempCanvas: HTMLCanvasElement;
    _tempCtx: CanvasRenderingContext2D;

    _dragging: boolean;
    _hasDragged: boolean;
    _dragPanel: Panel | null;
    dragScrollMode: boolean;
    _dragStartX: number;
    _dragStartY: number;
    _dragLastY: number;

    _hoveredPanel: Panel | null;
    _canvasRow!: HTMLElement;
    _resizeGrip: HTMLElement | null;
    _resizeCleanup: (() => void) | null;
    _savedState: ReturnType<NiftiViewer["_getState"]> | null;
    _model: AnyWidgetModel | null;

    constructor(container: HTMLElement, config: ViewerConfig, volumes: Volumes, images_string: string | null = null, overlays_string: string | null = null) {
        this.container = container;
        this.config = config;
        this.volumes = volumes;
        this.images_string = images_string;
        this.overlays_string = overlays_string;

        // State
        this.pos = [...config.initial_pos];
        this.posRas = [...config.initial_pos_ras];
        this.view = config.visualization;
        this.zoomFactor = config.zoom_factor;
        this.alpha = config.alpha;
        this.showOverlay = config.show_overlays;
        this.showContour = config.show_contour;
        this.showCrosshairs = config.show_crosshairs;
        this.fullCrosshairs = config.full_crosshairs;
        this.showBoundingBox = config.show_bounding_box;
        this.crosshairColor = config.crosshairs_color;
        this.imageColormaps = [...config.images_colormaps];
        this.overlayColormaps = [...config.overlays_colormaps];
        this.percentile = config.percentile;
        this.percentileLo = config.auto_range_lo_percentile || 0;
        this.autoRange = config.auto_range || false;
        this.focusedView = config.visualization === "multiplanar" ? "axial" : config.visualization as SingleView;
        this.bboxMargin = config.bbox_margin;
        this.caption = config.caption;
        this.smoothInterp = false;

        this._zoomScale = 1;

        this.imageRanges = config.image_ranges.map(r => [...r] as [number, number]);
        this.overlayRanges = config.overlay_ranges.map(r => r ? [...r] as [number, number] : null);

        this.viewport = computeViewport(config.shape, this.pos, this.zoomFactor);
        this.boundingBox = null;

        const _autoMask = config.overlay_labels_centers
            ? config.overlay_labels_centers.findIndex(x => x != null && typeof x === "object" && Object.keys(x).length > 0)
            : -1;
        this.currentMaskIndex = config.mask_index != null ? config.mask_index : (_autoMask >= 0 ? _autoMask : 0);
        this.currentLesionIndex = config.lesion_index;
        this.lesionLabels = this._getLesionLabels(this.currentMaskIndex);

        this.classificationData = config.classification_data ? JSON.parse(JSON.stringify(config.classification_data)) : null;
        this.classificationOptions = config.classification_options || [];
        this.classificationFile = config.classification_file || "";

        this.pressedKeys = new Set();
        this.panels = [];
        this.controls = {};

        this._tempCanvas = document.createElement("canvas");
        this._tempCtx = this._tempCanvas.getContext("2d")!;

        this._dragging = false;
        this._hasDragged = false;
        this._dragPanel = null;
        this.dragScrollMode = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragLastY = 0;

        this._hoveredPanel = null;
        this._resizeGrip = null;
        this._resizeCleanup = null;
        this._savedState = null;
        this._model = null;
    }

    _getLesionLabels(maskIdx: number): number[] {
        const lc = this.config.overlay_labels_centers;
        if (!lc || !lc[maskIdx]) return [];
        return Object.keys(lc[maskIdx]!).map(Number).sort((a, b) => a - b);
    }

    _getLesionCenter(maskIdx: number, label: number): [number, number, number] | null {
        const lc = this.config.overlay_labels_centers;
        if (!lc || !lc[maskIdx]) return null;
        return lc[maskIdx]![String(label)] || null;
    }

    // ── Init ──────────────────────────────────────────────────────────

    init(): void {
        this._buildDOM();
        this._setupEvents();
        this._setupResizeGrip();
        this._initLesionNav();
        this.render();
    }

    destroy(): void {
        if (this._resizeCleanup) this._resizeCleanup();
        this.container.innerHTML = "";
    }

    // ── Slice physical aspect ratio (height / width) ─────────────────

    _sliceAspect(view?: string): number {
        const { shape, voxel_sizes } = this.config;
        const v = (view || this.view || this.config.visualization || "axial").toLowerCase();
        const vs = voxel_sizes || [1, 1, 1];
        const s = shape || [256, 256, 256];
        switch (v) {
            case "axial":       return (s[1] * vs[1]) / (s[0] * vs[0]);
            case "coronal":     return (s[2] * vs[2]) / (s[0] * vs[0]);
            case "sagittal":    return (s[2] * vs[2]) / (s[1] * vs[1]);
            case "multiplanar": return this._sliceAspect(this.focusedView || "axial");
            default:            return 1.0;
        }
    }

    // ── DOM Construction ──────────────────────────────────────────────

    _buildDOM(): void {
        this.panels = [];
        this.controls = {};

        const el = this.container;
        el.classList.add("nv-viewer");
        el.setAttribute("tabindex", "0");

        // ── Upper controls ────────────────────────────────────────────
        const upperRow = createElement("div", "nv-controls-upper");

        // Position sliders
        const posBox = createElement("div", "nv-control-group");
        this.controls.sliderLR = createSlider("R\u2192L", 0, this.config.shape[0] - 1, this.posRas[0]);
        this.controls.sliderPA = createSlider("P\u2192A", 0, this.config.shape[1] - 1, this.posRas[1]);
        this.controls.sliderIS = createSlider("I\u2192S", 0, this.config.shape[2] - 1, this.posRas[2]);
        posBox.append(this.controls.sliderLR.container, this.controls.sliderPA.container, this.controls.sliderIS.container);

        // View + colormap + buttons
        const viewBox = createElement("div", "nv-control-group");
        this.controls.viewDropdown = createDropdown("View", [
            ["Sagittal (S)", "sagittal"], ["Coronal (C)", "coronal"],
            ["Axial (A)", "axial"], ["Multiplanar (M)", "multiplanar"],
        ], this.view);
        this.controls.imgCmapDropdown = createDropdown("IM CMap", this._cmapOptions(), this.imageColormaps[0]);
        this.controls.exportBtn = createButton("Export config");
        this.controls.saveBtn = createButton("Save to notebook");
        const btnRow = createElement("div", "nv-control-row");
        btnRow.append(this.controls.exportBtn, this.controls.saveBtn);
        viewBox.append(
            this.controls.viewDropdown.container, this.controls.imgCmapDropdown.container,
            btnRow,
        );

        // Overlay controls
        const overlayBox = createElement("div", "nv-control-group");
        this.controls.showOverlay = createCheckbox("Show overlays (w)", this.showOverlay);
        this.controls.showContour = createCheckbox("Show contour (c)", this.showContour);
        this.controls.showBBox = createCheckbox("Bounding box (b)", this.showBoundingBox);
        this.controls.alphaSlider = createSlider("\u03b1 (q/e)", 0, 100, Math.round(this.alpha * 100));
        this.controls.ovlCmapDropdown = createDropdown("OV CMap", this._cmapOptions(), this.overlayColormaps[0]);
        const ovlCmapRow = createElement("div", "nv-control-row");
        ovlCmapRow.append(this.controls.ovlCmapDropdown.container);
        overlayBox.append(
            this.controls.showOverlay.container, this.controls.showContour.container,
            this.controls.showBBox.container, this.controls.alphaSlider.container,
            ovlCmapRow,
        );
        if (!this.config.overlay_has_data.some(Boolean)) overlayBox.style.display = "none";

        // Zoom + percentile + crosshairs
        const zoomBox = createElement("div", "nv-control-group");
        this.controls.zoomSlider = createSlider("Zoom (+/-/0)", 100, 1500, Math.round(this.zoomFactor * 100));
        this.controls.autoRangeBtn = createButton(this.autoRange ? "AR: ON" : "AR: OFF");
        if (this.autoRange) this.controls.autoRangeBtn.classList.add("nv-btn-active");
        this.controls.percentileRange = createRangeSlider(
            "Percentile", 0, 10000,
            Math.round(this.percentileLo * 100),
            Math.round(this.percentile * 100),
        );
        this.controls.showCrosshairs = createCheckbox("Crosshairs (x)", this.showCrosshairs);
        this.controls.fullCrosshairs = createCheckbox("Full crosshairs (f)", this.fullCrosshairs);
        this.controls.smoothInterp = createCheckbox("Smooth (i)", this.smoothInterp);
        this.controls.crosshairColorDropdown = createDropdown("XH Color", [
            ["lime", "lime"], ["red", "red"], ["blue", "blue"], ["black", "black"], ["white", "white"]
        ], this.crosshairColor);
        const arRow = createElement("div", "nv-control-row");
        arRow.append(this.controls.autoRangeBtn, this.controls.percentileRange.container);
        const xhRow = createElement("div", "nv-control-row");
        xhRow.append(this.controls.showCrosshairs.container, this.controls.fullCrosshairs.container);
        zoomBox.append(
            this.controls.zoomSlider.container,
            arRow,
            xhRow,
            this.controls.crosshairColorDropdown.container,
            this.controls.smoothInterp.container,
        );

        upperRow.append(posBox, viewBox, overlayBox, zoomBox);
        el.appendChild(upperRow);

        // ── Canvas panels ─────────────────────────────────────────────
        const canvasRow = createElement("div", "nv-canvas-row");
        const { grid_dims, n_images, max_width } = this.config;
        const hPad = 40;
        const containerW = this.config._container_width || 800;
        const innerW = containerW - hPad;
        const effectiveW = max_width
            ? (max_width <= 1 ? Math.round(innerW * max_width) : Math.min(innerW, max_width))
            : innerW;
        const panelGap = 6;
        const effectiveWnoGap = effectiveW - panelGap * (grid_dims[1] - 1);
        this._basePanelW = Math.max(1, Math.floor(effectiveWnoGap / grid_dims[1]));
        if (this._sizeScale == null) this._sizeScale = 1.0;
        const panelW = Math.max(1, Math.round(this._basePanelW * this._sizeScale));
        const aspect = this._sliceAspect();
        const panelH = Math.max(1, Math.round(panelW * aspect));
        canvasRow.style.display = "grid";
        canvasRow.style.gridTemplateColumns = `repeat(${grid_dims[1]}, ${panelW}px)`;

        const dpr = window.devicePixelRatio || 1;
        for (let i = 0; i < n_images; i++) {
            const panelDiv = createElement("div", "nv-panel");
            const canvas = document.createElement("canvas");
            canvas.width = panelW * dpr;
            canvas.height = panelH * dpr;
            canvas.style.width = panelW + "px";
            canvas.style.height = panelH + "px";
            canvas.className = "nv-canvas";
            const ctx = canvas.getContext("2d")!;
            ctx.scale(dpr, dpr);
            panelDiv.appendChild(canvas);

            if (this.config.titles[i]) {
                const title = createElement("div", "nv-panel-title");
                title.textContent = this.config.titles[i];
                panelDiv.insertBefore(title, canvas);
            }

            this.panels.push({ canvas, ctx, panelDiv, imageIdx: i, w: panelW, h: panelH });
            canvasRow.appendChild(panelDiv);
        }
        this._canvasRow = canvasRow;
        el.appendChild(canvasRow);

        // Caption
        if (this.caption) {
            const captionEl = createElement("div", "nv-caption");
            captionEl.textContent = this.caption;
            el.appendChild(captionEl);
        }

        // ── Lower controls (lesion navigation) ────────────────────────
        const hasLesions = this.config.overlay_labels_centers.some(Boolean);
        if (hasLesions && !this.config.disable_lesions_viewer) {
            const lowerRow = createElement("div", "nv-controls-lower");

            this.controls.prevBtn = createButton("Prev (p)");
            this.controls.maskDropdown = createDropdown("Mask", this._maskOptions(), String(this.currentMaskIndex));
            this.controls.lesionDropdown = createDropdown("Label", this._lesionOptions(), this.currentLesionIndex != null ? String(this.currentLesionIndex) : (this.lesionLabels.length ? String(this.lesionLabels[0]) : ""));

            lowerRow.append(this.controls.prevBtn, this.controls.maskDropdown.container, this.controls.lesionDropdown.container);

            // Classification controls
            if (this.classificationData && this.classificationOptions.length) {
                this.controls.predLabel = createElement("span", "nv-pred-label") as HTMLSpanElement;
                this.controls.predLabel.textContent = "Pred: -";
                this.controls.classDropdown = createDropdown("True (t)", [["", ""], ...this.classificationOptions.map(o => [o, o] as [string, string])], "");
                this.controls.saveClassBtn = createButton("Save (s)");
                this.controls.saveClassBtn.classList.add("nv-btn-success");
                this.controls.saveClassLabel = createElement("span", "nv-save-label") as HTMLSpanElement;
                lowerRow.append(this.controls.predLabel, this.controls.classDropdown.container, this.controls.saveClassBtn, this.controls.saveClassLabel);
            }

            this.controls.nextBtn = createButton("Next (n)");
            lowerRow.appendChild(this.controls.nextBtn);
            el.appendChild(lowerRow);
        }

        // Config output area
        this.controls.configOutput = createElement("div", "nv-config-output");
        el.appendChild(this.controls.configOutput);

        this._resizeGrip = null;
    }

    // ── Helper methods ───────────────────────────────────────────────

    _cmapOptions(): [string, string][] {
        return ["gray", "Reds", "Greens", "hot", "hot_r", "jet", "rainbow", "bwr",
                "viridis", "autumn", "BuPu", "PuOr", "Pastel1", "tab20"].map(c => [c, c] as [string, string]);
    }

    _maskOptions(): [string, string][] {
        const opts: [string, string][] = [];
        const titles = this.config.titles || [];
        for (let i = 0; i < this.config.overlay_labels_centers.length; i++) {
            if (this.config.overlay_labels_centers[i]) {
                const t = titles[i];
                opts.push([t ? `${i}  ${t}` : String(i), String(i)]);
            }
        }
        return opts;
    }

    _lesionOptions(): [string, string][] {
        const props = (this.config.labels_properties || [])[this.currentMaskIndex];
        return this.lesionLabels.map(l => {
            const desc = props && props[String(l)];
            return [desc ? `${l}  —  ${desc}` : String(l), String(l)] as [string, string];
        });
    }

    // ── Events ────────────────────────────────────────────────────────

    _setupEvents(): void {
        const c = this.controls as ViewerControls;

        // Position sliders
        const onPosChange = () => {
            this.posRas = [
                parseInt(c.sliderLR.input.value),
                parseInt(c.sliderPA.input.value),
                parseInt(c.sliderIS.input.value),
            ];
            this.pos = [
                this.config.shape[0] - 1 - this.posRas[0],
                this.config.shape[1] - 1 - this.posRas[1],
                this.config.shape[2] - 1 - this.posRas[2],
            ];
            this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
            this.render();
        };
        c.sliderLR.input.addEventListener("input", onPosChange);
        c.sliderPA.input.addEventListener("input", onPosChange);
        c.sliderIS.input.addEventListener("input", onPosChange);

        // View
        c.viewDropdown.select.addEventListener("change", () => {
            this.view = c.viewDropdown.select.value as ViewType;
            if (this.view !== "multiplanar") this.focusedView = this.view as SingleView;
            this._setPanelScale(this._sizeScale);
        });

        // Colormaps
        c.imgCmapDropdown.select.addEventListener("change", () => {
            const cm = c.imgCmapDropdown.select.value;
            this.imageColormaps = this.imageColormaps.map(() => cm);
            this.render();
        });
        c.ovlCmapDropdown.select.addEventListener("change", () => {
            const cm = c.ovlCmapDropdown.select.value;
            const isIntOvl = this.config.overlay_is_integer || [];
            this.overlayColormaps = this.overlayColormaps.map((cur, i) =>
                isIntOvl[i] !== false ? cm : cur
            );
            this.render();
        });

        // Overlay toggles
        c.showOverlay.input.addEventListener("change", () => { this.showOverlay = c.showOverlay.input.checked; this.render(); });
        c.showContour.input.addEventListener("change", () => { this.showContour = c.showContour.input.checked; this.render(); });
        c.showBBox.input.addEventListener("change", () => { this.showBoundingBox = c.showBBox.input.checked; this.render(); });

        // Alpha
        c.alphaSlider.input.addEventListener("input", () => {
            this.alpha = parseInt(c.alphaSlider.input.value) / 100;
            this.render();
        });

        // Zoom
        c.zoomSlider.input.addEventListener("input", () => {
            this.zoomFactor = parseInt(c.zoomSlider.input.value) / 100;
            this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
            this.render();
        });

        // Percentile range (dual slider) — manual drag turns off AR
        const onPctChange = () => {
            this.percentile = parseInt(c.percentileRange.inputHi.value) / 100;
            this.percentileLo = parseInt(c.percentileRange.inputLo.value) / 100;
            if (this.autoRange) {
                this.autoRange = false;
                c.autoRangeBtn.textContent = "AR: OFF";
                c.autoRangeBtn.classList.remove("nv-btn-active");
            }
            this._recomputeImageRanges();
            this.render();
        };
        c.percentileRange.inputHi.addEventListener("change", onPctChange);
        c.percentileRange.inputLo.addEventListener("change", onPctChange);

        // Auto-range toggle
        c.autoRangeBtn.addEventListener("click", () => {
            this.autoRange = !this.autoRange;
            c.autoRangeBtn.textContent = this.autoRange ? "AR: ON" : "AR: OFF";
            c.autoRangeBtn.classList.toggle("nv-btn-active", this.autoRange);
            const targetHi = this.autoRange ? this.config.auto_range_percentile : 100.0;
            const targetLo = this.autoRange ? (this.config.auto_range_lo_percentile || 0) : 0;
            this.percentile = targetHi;
            this.percentileLo = targetLo;
            this._syncPercentileRange();
            this._recomputeImageRanges();
            this.render();
        });

        // Crosshairs + interpolation
        c.showCrosshairs.input.addEventListener("change", () => { this.showCrosshairs = c.showCrosshairs.input.checked; this.render(); });
        c.fullCrosshairs.input.addEventListener("change", () => { this.fullCrosshairs = c.fullCrosshairs.input.checked; this.render(); });
        c.smoothInterp.input.addEventListener("change", () => { this.smoothInterp = c.smoothInterp.input.checked; this.render(); });
        c.crosshairColorDropdown.select.addEventListener("change", () => { this.crosshairColor = c.crosshairColorDropdown.select.value; this.render(); });

        // Export config
        c.exportBtn.addEventListener("click", () => this._exportConfig());

        // Save to notebook
        c.saveBtn.addEventListener("click", () => this._saveToNotebook());

        // Canvas pointer events
        for (const panel of this.panels) {
            panel.canvas.addEventListener("pointerdown", (e) => this._onCanvasMouseDown(e, panel));
            panel.canvas.addEventListener("pointermove", (e) => this._onCanvasMouseMove(e, panel));
            panel.canvas.addEventListener("pointerup", (e) => this._onCanvasMouseUp(e, panel));
            panel.canvas.addEventListener("pointerleave", (e) => this._onCanvasMouseUp(e, panel));
            panel.canvas.addEventListener("wheel", (e) => this._onWheel(e, panel), { passive: false });
        }

        // Keyboard
        this.container.addEventListener("keydown", (e) => this._onKeyDown(e));
        this.container.addEventListener("keyup", (e) => this._onKeyUp(e));
        this.container.addEventListener("blur", () => this.pressedKeys.clear());

        // Re-focus after control interaction
        const refocus = (e: Event) => {
            const tag = (e.target as HTMLElement).tagName;
            if (tag === "INPUT" && (e.target as HTMLInputElement).type === "text") return;
            if (tag === "SELECT" && e.type === "mouseup") return;
            setTimeout(() => {
                // Don't steal focus from a text input that appeared after the click
                const active = document.activeElement;
                if (active && active.tagName === "INPUT" && (active as HTMLInputElement).type === "text") return;
                this.container.focus({ preventScroll: true });
            }, 0);
        };
        this.container.addEventListener("mouseup", refocus);
        this.container.addEventListener("change", refocus);

        // Lesion navigation
        if (c.prevBtn) c.prevBtn.addEventListener("click", () => this._navigateLesion(-1));
        if (c.nextBtn) c.nextBtn.addEventListener("click", () => this._navigateLesion(1));
        if (c.maskDropdown) {
            c.maskDropdown.select.addEventListener("change", () => {
                this.currentMaskIndex = parseInt(c.maskDropdown.select.value);
                this.lesionLabels = this._getLesionLabels(this.currentMaskIndex);
                this._updateLesionDropdown();
                this._navigateToCurrentLesion();
            });
        }
        if (c.lesionDropdown) {
            c.lesionDropdown.select.addEventListener("change", () => {
                this.currentLesionIndex = parseInt(c.lesionDropdown.select.value);
                this._navigateToCurrentLesion();
            });
        }

        // Classification
        if (c.classDropdown) {
            c.classDropdown.select.addEventListener("change", () => this._onClassChange());
        }
        if (c.saveClassBtn) {
            c.saveClassBtn.addEventListener("click", () => this._saveClassification());
        }
    }

    // ── Panel size (Cmd/Ctrl +/-/0) ──────────────────────────────────

    _setPanelScale(newScale: number): void {
        this._sizeScale = Math.max(0.15, Math.min(5.0, newScale));
        const panelW = Math.max(1, Math.round(this._basePanelW * this._sizeScale));
        const aspect = this._sliceAspect();
        const panelH = Math.max(1, Math.round(panelW * aspect));
        const dpr = window.devicePixelRatio || 1;

        this._canvasRow.style.gridTemplateColumns =
            `repeat(${this.config.grid_dims[1]}, ${panelW}px)`;

        for (const p of this.panels) {
            p.w = panelW;
            p.h = panelH;
            p.canvas.width = panelW * dpr;
            p.canvas.height = panelH * dpr;
            p.canvas.style.width = panelW + "px";
            p.canvas.style.height = panelH + "px";
            p.ctx = p.canvas.getContext("2d")!;
            p.ctx.scale(dpr, dpr);
        }
        this.render();
    }

    // ── Zoom (CSS transform) ────────────────────────────────────────

    _applyZoom(): void {
        if (this._zoomScale === 1) {
            this.container.style.transform = "";
            this.container.style.transformOrigin = "";
            this.container.style.marginBottom = "";
        } else {
            this.container.style.transformOrigin = "top center";
            this.container.style.transform = `scale(${this._zoomScale})`;
            const h = this.container.offsetHeight;
            this.container.style.marginBottom = `${h * (this._zoomScale - 1)}px`;
        }
    }

    _setupResizeGrip(): void {
        if (this._resizeCleanup) { this._resizeCleanup(); this._resizeCleanup = null; }
    }

    _initLesionNav(): void {
        if (this.currentLesionIndex != null && this.lesionLabels.includes(this.currentLesionIndex)) {
            const c = this.controls as ViewerControls;
            if (c.lesionDropdown) c.lesionDropdown.select.value = String(this.currentLesionIndex);
            this._navigateToCurrentLesion();
        } else if (this.lesionLabels.length) {
            this.currentLesionIndex = this.lesionLabels[0];
        }
        this._updateClassificationDisplay();
    }

    _updateLesionDropdown(): void {
        const c = this.controls as ViewerControls;
        if (!c.lesionDropdown) return;
        const sel = c.lesionDropdown.select;
        const props = (this.config.labels_properties || [])[this.currentMaskIndex];
        sel.innerHTML = "";
        for (const lbl of this.lesionLabels) {
            const opt = document.createElement("option");
            opt.value = String(lbl);
            const desc = props && props[String(lbl)];
            opt.textContent = desc ? `${lbl}  —  ${desc}` : String(lbl);
            sel.appendChild(opt);
        }
        if (this.lesionLabels.length) {
            this.currentLesionIndex = this.lesionLabels[0];
            sel.value = String(this.currentLesionIndex);
        }
    }

    _navigateLesion(direction: number): void {
        if (!this.lesionLabels.length) return;
        let idx = this.lesionLabels.indexOf(this.currentLesionIndex!);
        if (idx < 0) idx = 0;
        idx = (idx + direction + this.lesionLabels.length) % this.lesionLabels.length;
        this.currentLesionIndex = this.lesionLabels[idx];
        const c = this.controls as ViewerControls;
        if (c.lesionDropdown) c.lesionDropdown.select.value = String(this.currentLesionIndex);
        this._navigateToCurrentLesion();
    }

    _navigateToCurrentLesion(): void {
        const center = this._getLesionCenter(this.currentMaskIndex, this.currentLesionIndex!);
        if (!center) return;

        this.pos = [
            this.config.shape[0] - 1 - center[0],
            this.config.shape[1] - 1 - center[1],
            this.config.shape[2] - 1 - center[2],
        ];
        this.posRas = [...center];

        const c = this.controls as ViewerControls;
        c.sliderLR.input.value = String(this.posRas[0]);
        c.sliderLR.valSpan.textContent = String(this.posRas[0]);
        c.sliderPA.input.value = String(this.posRas[1]);
        c.sliderPA.valSpan.textContent = String(this.posRas[1]);
        c.sliderIS.input.value = String(this.posRas[2]);
        c.sliderIS.valSpan.textContent = String(this.posRas[2]);

        this._computeBoundingBox();
        this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
        this._updateClassificationDisplay();
        this.render();
    }

    _computeBoundingBox(): void {
        const bboxes = this.config.precomputed_bboxes;
        if (!bboxes || !bboxes[this.currentMaskIndex]) {
            this.boundingBox = null;
            return;
        }
        const bb = bboxes[this.currentMaskIndex]![String(this.currentLesionIndex!)];
        this.boundingBox = bb || null;
    }

    // ── Classification ────────────────────────────────────────────────

    _updateClassificationDisplay(): void {
        const c = this.controls as ViewerControls;
        if (!this.classificationData || !c.predLabel) return;
        const lbl = String(this.currentLesionIndex);
        const finding = this.classificationData.findings?.find(
            f => (f.lesion_id || f.id_json_nel) === lbl
        );
        if (finding) {
            c.predLabel.textContent = `Pred: ${finding.pred_class || "-"}`;
            const trueVal = finding.true_class || "";
            c.classDropdown.select.value = trueVal;
        } else {
            c.predLabel.textContent = "Pred: -";
            c.classDropdown.select.value = "";
        }
        c.saveClassLabel.textContent = "";
    }

    _onClassChange(): void {
        const c = this.controls as ViewerControls;
        if (!this.classificationData) return;
        const lbl = String(this.currentLesionIndex);
        const finding = this.classificationData.findings?.find(
            f => (f.lesion_id || f.id_json_nel) === lbl
        );
        if (finding) {
            finding.true_class = c.classDropdown.select.value;
            c.saveClassLabel.textContent = "";
        }
    }

    _saveClassification(): void {
        const c = this.controls as ViewerControls;
        if (!this.classificationData || !this._model) return;
        this._model.set("_save_request", JSON.stringify(this.classificationData));
        this._model.save_changes();
        if (c.saveClassLabel) c.saveClassLabel.textContent = "Saved!";
    }

    // ── Canvas Mouse (click + drag) ─────────────────────────────────

    _onCanvasMouseDown(e: PointerEvent, panel: Panel): void {
        if (e.button !== 0) return;
        this._dragging = true;
        this._hasDragged = false;
        this._dragPanel = panel;
        this._dragStartX = e.offsetX;
        this._dragStartY = e.offsetY;
        this._dragLastY = e.offsetY;
        this.container.focus({ preventScroll: true });
    }

    _onCanvasMouseMove(e: PointerEvent, panel: Panel): void {
        if (!this._dragging || this._dragPanel !== panel) return;
        if (this.dragScrollMode) {
            const deltaY = e.offsetY - this._dragLastY;
            const sliceDelta = Math.round(-deltaY / 10);
            if (sliceDelta !== 0) {
                this._scrollSlice(sliceDelta);
                this._dragLastY = e.offsetY;
            }
        } else {
            this._handleCanvasPointer(e, panel, true);
        }
    }

    _onCanvasMouseUp(e: PointerEvent, panel: Panel): void {
        if (this._dragging && this._dragPanel === panel && !this.dragScrollMode) {
            this._handleCanvasPointer(e, panel);
        }
        this._dragging = false;
        this._hasDragged = false;
        this._dragPanel = null;
    }

    _handleCanvasPointer(e: PointerEvent, panel: Panel, noPan: boolean = false): void {
        const mx = e.offsetX;
        const my = e.offsetY;

        const views: SingleView[] = this.view === "multiplanar"
            ? ["axial", "sagittal", "coronal"]
            : [this.view as SingleView];

        for (const v of views) {
            const region = this._getViewRegion(panel, v);
            if (!region) continue;
            if (mx >= region.dx && mx < region.dx + region.dw &&
                my >= region.dy && my < region.dy + region.dh) {
                const voxX = Math.round((mx - region.dx) / region.scaleX);
                const voxY = Math.round((my - region.dy) / region.scaleY);
                this._hoveredPanel = panel;
                this._setPositionFromView(v, voxX, voxY, noPan);
                this.focusedView = v;
                return;
            }
        }
    }

    _onWheel(e: WheelEvent, panel: Panel): void {
        if (!e.shiftKey) return;

        e.preventDefault();
        e.stopPropagation();

        if (this.view === "multiplanar") {
            const mx = e.offsetX;
            const my = e.offsetY;
            for (const v of ["axial", "sagittal", "coronal"] as SingleView[]) {
                const region = this._getViewRegion(panel, v);
                if (region && mx >= region.dx && mx < region.dx + region.dw &&
                    my >= region.dy && my < region.dy + region.dh) {
                    this.focusedView = v;
                    break;
                }
            }
        }

        const dir = e.deltaY > 0 ? -1 : 1;
        this._scrollSlice(dir);
        this.container.focus({ preventScroll: true });
    }

    _setPositionFromView(view: SingleView, voxX: number, voxY: number, noPan: boolean = false): void {
        const vp = this.viewport;
        switch (view) {
            case "axial":
                this.pos[0] = Math.min(Math.max(vp[0][0] + voxX, 0), this.config.shape[0] - 1);
                this.pos[1] = Math.min(Math.max(vp[1][0] + voxY, 0), this.config.shape[1] - 1);
                break;
            case "sagittal":
                this.pos[1] = Math.min(Math.max(vp[1][0] + voxX, 0), this.config.shape[1] - 1);
                this.pos[2] = Math.min(Math.max(vp[2][0] + voxY, 0), this.config.shape[2] - 1);
                break;
            case "coronal":
                this.pos[0] = Math.min(Math.max(vp[0][0] + voxX, 0), this.config.shape[0] - 1);
                this.pos[2] = Math.min(Math.max(vp[2][0] + voxY, 0), this.config.shape[2] - 1);
                break;
        }
        this.posRas = [
            this.config.shape[0] - 1 - this.pos[0],
            this.config.shape[1] - 1 - this.pos[1],
            this.config.shape[2] - 1 - this.pos[2],
        ];
        this._syncSlidersFromPos();
        if (!noPan) {
            this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
        }
        this.render();
    }

    _syncSlidersFromPos(): void {
        const c = this.controls as ViewerControls;
        c.sliderLR.input.value = String(this.posRas[0]);
        c.sliderLR.valSpan.textContent = String(this.posRas[0]);
        c.sliderPA.input.value = String(this.posRas[1]);
        c.sliderPA.valSpan.textContent = String(this.posRas[1]);
        c.sliderIS.input.value = String(this.posRas[2]);
        c.sliderIS.valSpan.textContent = String(this.posRas[2]);
    }

    // ── Keyboard ──────────────────────────────────────────────────────

    _onKeyDown(e: KeyboardEvent): void {
        const active = document.activeElement;
        if (active && active !== this.container &&
            (active.tagName === "SELECT" || active.tagName === "INPUT")) return;

        if (e.metaKey || e.ctrlKey) {
            this.pressedKeys.clear();
            if (e.key === "=" || e.key === "+") {
                e.preventDefault(); e.stopPropagation();
                this._setPanelScale(this._sizeScale * 1.15);
                return;
            }
            if (e.key === "-") {
                e.preventDefault(); e.stopPropagation();
                this._setPanelScale(this._sizeScale / 1.15);
                return;
            }
            if (e.key === "0") {
                e.preventDefault(); e.stopPropagation();
                this._setPanelScale(1.0);
                return;
            }
        }

        const key = e.key;

        if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return;

        if (this.pressedKeys.has(key)) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        this.pressedKeys.add(key);
        if (this.pressedKeys.size !== 1) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const c = this.controls as ViewerControls;

        switch (key) {
            case "S": this._setView("sagittal"); break;
            case "C": this._setView("coronal"); break;
            case "A": this._setView("axial"); break;
            case "M": this._setView("multiplanar"); break;
            case "w":
                this.showOverlay = !this.showOverlay;
                c.showOverlay.input.checked = this.showOverlay;
                this.render();
                break;
            case "q":
                this.alpha = Math.max(0, this.alpha - 0.1);
                c.alphaSlider.input.value = String(Math.round(this.alpha * 100));
                c.alphaSlider.valSpan.textContent = String(Math.round(this.alpha * 100));
                this.render();
                break;
            case "e":
                this.alpha = Math.min(1, this.alpha + 0.1);
                c.alphaSlider.input.value = String(Math.round(this.alpha * 100));
                c.alphaSlider.valSpan.textContent = String(Math.round(this.alpha * 100));
                this.render();
                break;
            case "c":
                this.showContour = !this.showContour;
                c.showContour.input.checked = this.showContour;
                this.render();
                break;
            case "x":
                this.showCrosshairs = !this.showCrosshairs;
                c.showCrosshairs.input.checked = this.showCrosshairs;
                this.render();
                break;
            case "f":
                this.fullCrosshairs = !this.fullCrosshairs;
                c.fullCrosshairs.input.checked = this.fullCrosshairs;
                this.render();
                break;
            case "i":
                this.smoothInterp = !this.smoothInterp;
                c.smoothInterp.input.checked = this.smoothInterp;
                this.render();
                break;
            case "b":
                this.showBoundingBox = !this.showBoundingBox;
                c.showBBox.input.checked = this.showBoundingBox;
                this.render();
                break;
            case "+": case "=":
                this.zoomFactor = Math.min(this.zoomFactor + 0.5, 15);
                c.zoomSlider.input.value = String(Math.round(this.zoomFactor * 100));
                c.zoomSlider.valSpan.textContent = String(Math.round(this.zoomFactor * 100));
                this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
                this.render();
                break;
            case "-":
                this.zoomFactor = Math.max(this.zoomFactor - 0.5, 1);
                c.zoomSlider.input.value = String(Math.round(this.zoomFactor * 100));
                c.zoomSlider.valSpan.textContent = String(Math.round(this.zoomFactor * 100));
                this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
                this.render();
                break;
            case "0":
                this.zoomFactor = 1;
                c.zoomSlider.input.value = String(100);
                c.zoomSlider.valSpan.textContent = String(100);
                this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
                this.render();
                break;
            case "p": this._navigateLesion(-1); break;
            case "n": this._navigateLesion(1); break;
            case "j": case "k":
                this._scrollSlice(key === "j" ? -1 : 1);
                break;
            case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight":
            case "PageUp": case "PageDown":
                this._handleArrowKey(key);
                break;
            case "t": case "T":
                this._cycleClass(key === "t" ? 1 : -1);
                break;
            case "s":
                this._saveClassification();
                break;
            case "d":
                this.dragScrollMode = !this.dragScrollMode;
                if (this.dragScrollMode) {
                    this.container.classList.add("nv-drag-scroll-mode");
                } else {
                    this.container.classList.remove("nv-drag-scroll-mode");
                }
                console.log(`Drag-to-scroll mode: ${this.dragScrollMode ? 'ON (drag vertically to scroll slices)' : 'OFF (normal crosshair control)'}`);
                break;
        }
    }

    _onKeyUp(e: KeyboardEvent): void {
        const key = e.key;
        if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return;
        if (this.pressedKeys.has(key)) {
            this.pressedKeys.delete(key);
        } else {
            this.pressedKeys.clear();
        }
    }

    _setView(v: ViewType): void {
        const c = this.controls as ViewerControls;
        this.view = v;
        c.viewDropdown.select.value = v;
        if (v !== "multiplanar") this.focusedView = v as SingleView;
        this._setPanelScale(this._sizeScale);
    }

    _scrollSlice(dir: number): void {
        const c = this.controls as ViewerControls;
        const shape = this.config.shape;
        const sliderMap: Record<SingleView, { dim: number; slider: typeof c.sliderIS }> = {
            axial:    { dim: 2, slider: c.sliderIS },
            sagittal: { dim: 0, slider: c.sliderLR },
            coronal:  { dim: 1, slider: c.sliderPA },
        };
        const entry = sliderMap[this.focusedView];
        if (!entry) return;
        const newVal = Math.max(0, Math.min(shape[entry.dim] - 1, this.posRas[entry.dim] + dir));
        this.posRas[entry.dim] = newVal;
        this.pos[entry.dim] = shape[entry.dim] - 1 - newVal;
        entry.slider.input.value = String(newVal);
        entry.slider.valSpan.textContent = String(newVal);
        this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
        this.render();
    }

    _handleArrowKey(key: string): void {
        const c = this.controls as ViewerControls;
        const mapping: Record<SingleView, Record<string, [string, number]>> = {
            axial: {
                ArrowUp: ["pa", 1], ArrowDown: ["pa", -1],
                ArrowLeft: ["lr", 1], ArrowRight: ["lr", -1],
                PageUp: ["is", 1], PageDown: ["is", -1],
            },
            coronal: {
                ArrowUp: ["is", 1], ArrowDown: ["is", -1],
                ArrowLeft: ["lr", 1], ArrowRight: ["lr", -1],
                PageUp: ["pa", -1], PageDown: ["pa", 1],
            },
            sagittal: {
                ArrowUp: ["is", 1], ArrowDown: ["is", -1],
                ArrowLeft: ["pa", 1], ArrowRight: ["pa", -1],
                PageUp: ["lr", -1], PageDown: ["lr", 1],
            },
        };
        const m = mapping[this.focusedView];
        if (!m || !m[key]) return;
        const [axis, delta] = m[key];
        const dimMap: Record<string, number> = { lr: 0, pa: 1, is: 2 };
        const sliderMap: Record<string, typeof c.sliderLR> = { lr: c.sliderLR, pa: c.sliderPA, is: c.sliderIS };
        const dim = dimMap[axis];
        const shape = this.config.shape;
        const newVal = Math.max(0, Math.min(shape[dim] - 1, this.posRas[dim] + delta));
        this.posRas[dim] = newVal;
        this.pos[dim] = shape[dim] - 1 - newVal;
        sliderMap[axis].input.value = String(newVal);
        sliderMap[axis].valSpan.textContent = String(newVal);
        this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
        this.render();
    }

    _cycleClass(dir: number): void {
        const c = this.controls as ViewerControls;
        if (!c.classDropdown) return;
        const opts = Array.from(c.classDropdown.select.options).map(o => o.value);
        const cur = c.classDropdown.select.value;
        let idx = opts.indexOf(cur);
        idx = (idx + dir + opts.length) % opts.length;
        c.classDropdown.select.value = opts[idx];
        this._onClassChange();
    }

    // ── Percentile recomputation ──────────────────────────────────────

    _syncPercentileRange(): void {
        const c = this.controls as ViewerControls;
        const hiVal = String(Math.round(this.percentile * 100));
        const loVal = String(Math.round(this.percentileLo * 100));
        c.percentileRange.inputHi.value = hiVal;
        c.percentileRange.valHiSpan.textContent = hiVal;
        c.percentileRange.inputLo.value = loVal;
        c.percentileRange.valLoSpan.textContent = loVal;
        // Update the fill bar between thumbs
        (c.percentileRange.container as any)._updateFill?.();
    }

    _recomputeImageRanges(): void {
        const luts = this.config.percentile_lut;
        for (let i = 0; i < this.volumes.images.length; i++) {
            if (!luts || !luts[i]) continue;
            const lut = luts[i]!;
            const hiVal = this._lookupPct(lut.hi, this.percentile);
            const loVal = this._lookupPct(lut.lo, this.percentileLo);
            if (hiVal != null) {
                this.imageRanges[i] = [loVal ?? this.imageRanges[i][0], hiVal];
            }
        }
    }

    _lookupPct(table: Record<string, number>, pct: number): number | undefined {
        const p100 = Math.round(pct * 100);
        // Try fine step (5) first, then coarse (50)
        for (const step of [5, 50]) {
            const key = String(Math.round(p100 / step) * step);
            if (key in table) return table[key];
        }
        // Fallback: nearest key
        const keys = Object.keys(table).map(Number);
        let closest = keys[0];
        let minDist = Math.abs(p100 - closest);
        for (const k of keys) {
            const d = Math.abs(p100 - k);
            if (d < minDist) { closest = k; minDist = d; }
        }
        return table[String(closest)];
    }

    // ── Export Config ─────────────────────────────────────────────────

    _exportConfig(): void {
        const c = this.controls as ViewerControls;
        const lines = ["notebook_viewer("];

        const toPy = (v: unknown, key: string): string => {
            if (typeof v === "boolean") return v ? "True" : "False";
            if (typeof v === "string") return `"${v}"`;
            if (Array.isArray(v)) {
                if (key === "grid_dims") return `(${v.join(", ")})`;
                return JSON.stringify(v.map(x => typeof x === "boolean" ? (x ? "True" : "False") : x));
            }
            return String(v);
        };
        const add = (k: string, v: unknown) => lines.push(`    ${k}=${toPy(v, k)},`);

        const imagesStr = this.config.images_str || this.images_string;
        const overlaysStr = this.config.overlays_str || this.overlays_string;
        if (imagesStr)  lines.push(`    images=${imagesStr},`);
        if (this.config.overlay_has_data.some(Boolean) && overlaysStr)
            lines.push(`    overlays=${overlaysStr},`);

        const mw = this.config.max_width;
        const mwExport = (mw != null && mw <= 1)
            ? mw
            : (Math.round((this.panels[0]?.w || 0) * this.config.grid_dims[1] * this._zoomScale) || null);

        const collapseCmap = (arr: string[]) => arr.every(c => c === arr[0]) ? arr[0] : arr;

        const DEFAULTS: Record<string, unknown> = {
            visualization:          "axial",
            show_overlays:          true,
            show_contour:           false,
            show_crosshairs:        true,
            full_crosshairs:        false,
            crosshairs_color:       "lime",
            alpha:                  1,
            percentile:             100,
            zoom_factor:            1,
            show_bounding_box:      false,
            disable_lesions_viewer: false,
            bbox_margin:            20,
            images_colormaps:       "gray",
            overlays_colormaps:     "rainbow",
        };

        const params: [string, unknown][] = [
            ["titles",                  this.config.titles.some(Boolean) ? this.config.titles : null],
            ["grid_dims",               this.config.grid_dims_explicit ? this.config.grid_dims : null],
            ["max_width",               mwExport],
            ["visualization",           this.view],
            ["pos_lr",                  this.posRas[0]],
            ["pos_pa",                  this.posRas[1]],
            ["pos_is",                  this.posRas[2]],
            ["zoom_factor",             Math.round(this.zoomFactor * 1000) / 1000],
            ["alpha",                   Math.round(this.alpha * 10) / 10],
            ["percentile",              Math.round(this.percentile * 100) / 100],
            ["caption",                 this.caption || null],
            ["show_overlays",           this.showOverlay],
            ["show_contour",            this.showContour],
            ["show_crosshairs",         this.showCrosshairs],
            ["full_crosshairs",         this.fullCrosshairs],
            ["crosshairs_color",        this.crosshairColor],
            ["images_colormaps",        collapseCmap(this.imageColormaps)],
            ["overlays_colormaps",      collapseCmap(this.overlayColormaps)],
            ["show_bounding_box",       this.showBoundingBox],
            ["disable_lesions_viewer",  this.config.disable_lesions_viewer],
            ["bbox_margin",             this.config.bbox_margin],
            ["mask_index",              this.currentMaskIndex],
            ["lesion_index",            this.currentLesionIndex],
        ];
        for (const [k, v] of params) {
            if (v == null) continue;
            if (k in DEFAULTS && v === DEFAULTS[k]) continue;
            add(k, v);
        }

        lines.push(")");
        const code = lines.join("\n");

        navigator.clipboard.writeText(code).then(() => {
            c.configOutput.innerHTML = '<span style="color:lime;font-size:16px">Copied to clipboard</span>';
            setTimeout(() => { c.configOutput.innerHTML = ""; }, 3000);
        }).catch(() => {
            c.configOutput.innerHTML = `<pre style="color:#ccc;font-size:11px">${code}</pre>`;
        });
    }

    // ── Save to Notebook ──────────────────────────────────────────────

    _saveToNotebook(): void {
        const container = this.container;

        const { grid_dims } = this.config;
        const panelW = this.panels[0]?.w || 200;
        const panelH = this.panels[0]?.h || 200;
        const totalW = panelW * grid_dims[1];
        const panelsH = panelH * grid_dims[0];
        const captionH = this.caption ? 24 : 0;
        const totalH = panelsH + captionH;

        const compositeCanvas = document.createElement("canvas");
        compositeCanvas.width = totalW;
        compositeCanvas.height = totalH;
        const compCtx = compositeCanvas.getContext("2d")!;

        compCtx.fillStyle = "#000000";
        compCtx.fillRect(0, 0, totalW, totalH);

        for (let i = 0; i < this.panels.length; i++) {
            const row = Math.floor(i / grid_dims[1]);
            const col = i % grid_dims[1];
            const dx = col * panelW;
            const dy = row * panelH;

            compCtx.drawImage(this.panels[i].canvas, dx, dy, panelW, panelH);

            const title = this.config.titles[i];
            if (title) {
                const tfs = Math.max(10, Math.round(panelW * 0.05));
                compCtx.font = `bold ${tfs}px sans-serif`;
                compCtx.textAlign = "center";
                compCtx.textBaseline = "top";
                compCtx.strokeStyle = "black";
                compCtx.lineWidth = 3;
                compCtx.strokeText(title, dx + panelW / 2, dy + tfs * 0.25);
                compCtx.fillStyle = "#ffffff";
                compCtx.fillText(title, dx + panelW / 2, dy + tfs * 0.25);
            }
        }

        if (this.caption) {
            compCtx.fillStyle = "#ffffff";
            compCtx.font = `${Math.max(10, Math.round(panelW * 0.05))}px sans-serif`;
            compCtx.textAlign = "center";
            compCtx.textBaseline = "middle";
            compCtx.fillText(this.caption, totalW / 2, panelsH + captionH / 2);
        }

        const dataUrl = compositeCanvas.toDataURL("image/png");

        this._savedState = this._getState();

        const staticDiv = document.createElement("div");
        staticDiv.className = "nv-static-view";

        const img = document.createElement("img");
        img.src = dataUrl;
        img.style.maxWidth = "100%";
        img.style.borderRadius = "4px";
        staticDiv.appendChild(img);

        const btnRow = createElement("div", "nv-controls-upper");
        btnRow.style.marginTop = "8px";

        const saveImgBtn = createButton("Save image");
        saveImgBtn.addEventListener("click", () => {
            const a = document.createElement("a");
            a.href = dataUrl;
            a.download = "viewer_snapshot.png";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        });

        const copyBtn = createButton("Copy to clipboard");
        copyBtn.addEventListener("click", () => {
            compositeCanvas.toBlob((blob) => {
                if (blob && navigator.clipboard && navigator.clipboard.write) {
                    navigator.clipboard.write([
                        new ClipboardItem({ "image/png": blob }),
                    ]).then(() => {
                        copyBtn.textContent = "Copied!";
                        setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 2000);
                    }).catch(() => {
                        copyBtn.textContent = "Copy failed";
                        setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 2000);
                    });
                }
            }, "image/png");
        });

        const returnBtn = createButton("Return to interactive");
        returnBtn.classList.add("nv-btn-success");
        returnBtn.addEventListener("click", () => {
            const w = container.offsetWidth;
            if (w > 0) this.config._container_width = w;
            container.style.transform = "";
            container.style.marginBottom = "";
            container.innerHTML = "";
            this._buildDOM();
            this._setupEvents();
            this._setupResizeGrip();
            this._restoreState(this._savedState!);
            this.render();
            this.container.focus({ preventScroll: true });
        });

        btnRow.append(saveImgBtn, copyBtn, returnBtn);
        staticDiv.appendChild(btnRow);

        container.innerHTML = "";
        container.appendChild(staticDiv);
    }

    _getState() {
        return {
            pos: [...this.pos],
            posRas: [...this.posRas],
            view: this.view,
            zoomFactor: this.zoomFactor,
            alpha: this.alpha,
            showOverlay: this.showOverlay,
            showContour: this.showContour,
            showCrosshairs: this.showCrosshairs,
            fullCrosshairs: this.fullCrosshairs,
            showBoundingBox: this.showBoundingBox,
            smoothInterp: this.smoothInterp,
            crosshairColor: this.crosshairColor,
            imageColormaps: [...this.imageColormaps],
            overlayColormaps: [...this.overlayColormaps],
            percentile: this.percentile,
            percentileLo: this.percentileLo,
            focusedView: this.focusedView,
            currentMaskIndex: this.currentMaskIndex,
            currentLesionIndex: this.currentLesionIndex,
            _zoomScale: this._zoomScale,
        };
    }

    _restoreState(state: ReturnType<NiftiViewer["_getState"]>): void {
        Object.assign(this, {
            pos: state.pos,
            posRas: state.posRas,
            view: state.view,
            zoomFactor: state.zoomFactor,
            alpha: state.alpha,
            showOverlay: state.showOverlay,
            showContour: state.showContour,
            showCrosshairs: state.showCrosshairs,
            fullCrosshairs: state.fullCrosshairs,
            showBoundingBox: state.showBoundingBox,
            smoothInterp: state.smoothInterp ?? false,
            crosshairColor: state.crosshairColor,
            imageColormaps: state.imageColormaps,
            overlayColormaps: state.overlayColormaps,
            percentile: state.percentile,
            percentileLo: state.percentileLo ?? 0,
            focusedView: state.focusedView,
            currentMaskIndex: state.currentMaskIndex,
            currentLesionIndex: state.currentLesionIndex,
            _zoomScale: state._zoomScale,
        });
        this._applyZoom();

        this.viewport = computeViewport(this.config.shape, this.pos, this.zoomFactor);
        this.imageRanges = this.config.image_ranges.map(r => [...r] as [number, number]);
        this._recomputeImageRanges();
        this._dragging = false;
        this._hasDragged = false;
        this._dragPanel = null;
        this.dragScrollMode = false;
        this.container.classList.remove("nv-drag-scroll-mode");
        this.pressedKeys = new Set();

        this._computeBoundingBox();

        const c = this.controls as ViewerControls;
        this._syncSlidersFromPos();
        c.viewDropdown.select.value = this.view;
        c.imgCmapDropdown.select.value = this.imageColormaps[0];
        c.ovlCmapDropdown.select.value = this.overlayColormaps[0];
        c.showOverlay.input.checked = this.showOverlay;
        c.showContour.input.checked = this.showContour;
        c.showBBox.input.checked = this.showBoundingBox;
        c.alphaSlider.input.value = String(Math.round(this.alpha * 100));
        c.alphaSlider.valSpan.textContent = String(Math.round(this.alpha * 100));
        c.zoomSlider.input.value = String(Math.round(this.zoomFactor * 100));
        c.zoomSlider.valSpan.textContent = String(Math.round(this.zoomFactor * 100));
        this._syncPercentileRange();
        c.showCrosshairs.input.checked = this.showCrosshairs;
        c.fullCrosshairs.input.checked = this.fullCrosshairs;
        c.smoothInterp.input.checked = this.smoothInterp;
        c.crosshairColorDropdown.select.value = this.crosshairColor;

        if (c.maskDropdown) c.maskDropdown.select.value = String(this.currentMaskIndex);
        this.lesionLabels = this._getLesionLabels(this.currentMaskIndex);
        this._updateLesionDropdown();
        if (c.lesionDropdown && this.currentLesionIndex != null) {
            c.lesionDropdown.select.value = String(this.currentLesionIndex);
        }
        this._updateClassificationDisplay();
    }

    // ── Main Render ───────────────────────────────────────────────────

    render(): void {
        for (const panel of this.panels) {
            this._renderPanel(panel);
        }
    }

    _renderPanel(panel: Panel): void {
        const { ctx, imageIdx } = panel;
        const cw = panel.w;
        const ch = panel.h;

        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, cw, ch);

        const views: SingleView[] = this.view === "multiplanar"
            ? ["axial", "sagittal", "coronal"]
            : [this.view as SingleView];

        for (const v of views) {
            this._renderView(panel, v, imageIdx);
        }
    }

    _getViewRegion(panel: Panel, view: SingleView): ViewRegion | null {
        const cw = panel.w;
        const ch = panel.h;
        const shape = this.config.shape;
        const vp = this.viewport;
        const vs = this.config.voxel_sizes;

        let regionX: number, regionY: number, regionW: number, regionH: number;
        if (this.view === "multiplanar") {
            const g = 1;
            const hw = Math.floor(cw / 2);
            const hh = Math.floor(ch / 2);
            switch (view) {
                case "axial":    regionX = 0;      regionY = 0;      regionW = hw - g;          regionH = hh - g; break;
                case "sagittal": regionX = hw + g;  regionY = 0;      regionW = cw - hw - g;     regionH = hh - g; break;
                case "coronal":  regionX = hw + g;  regionY = hh + g; regionW = cw - hw - g;     regionH = ch - hh - g; break;
            }
        } else {
            regionX = 0; regionY = 0; regionW = cw; regionH = ch;
        }

        const dims = getSliceDims(shape, view, vp);
        const sliceW = dims[0];
        const sliceH = dims[1];
        if (sliceW === 0 || sliceH === 0) return null;

        const aspect = getAspectRatio(vs, view);

        const dispW = sliceW;
        const dispH = sliceH * aspect;
        const scale = Math.min(regionW! / dispW, regionH! / dispH);
        const drawW = dispW * scale;
        const drawH = dispH * scale;
        const dx = regionX! + (regionW! - drawW) / 2;
        const dy = regionY! + (regionH! - drawH) / 2;

        return {
            dx, dy, dw: drawW, dh: drawH,
            sliceW, sliceH,
            scaleX: drawW / sliceW,
            scaleY: drawH / sliceH,
            regionX: regionX!, regionY: regionY!, regionW: regionW!, regionH: regionH!,
        };
    }

    _renderView(panel: Panel, view: SingleView, imageIdx: number): void {
        const { ctx } = panel;
        const region = this._getViewRegion(panel, view);
        if (!region) return;

        const { dx, dy, dw, dh, sliceW, sliceH, scaleX, scaleY } = region;

        // ── Image slice ───────────────────────────────────────────────
        const imgData = this.volumes.images[imageIdx];
        const slice = extractSlice(imgData, this.config.shape, view, this.pos, this.viewport);
        const lut = getLUT(this.imageColormaps[imageIdx] || "gray");
        const range = this.imageRanges[imageIdx] || [0, 1];
        const imageData = renderSliceToImageData(slice.data, slice.width, slice.height, lut, range[0], range[1]);

        this._tempCanvas.width = sliceW;
        this._tempCanvas.height = sliceH;
        this._tempCtx.putImageData(imageData, 0, 0);

        ctx.imageSmoothingEnabled = this.smoothInterp;
        (ctx as any).imageSmoothingQuality = "high";
        ctx.drawImage(this._tempCanvas, dx, dy, dw, dh);

        // ── Overlay slice ─────────────────────────────────────────────
        const ovlData = this.volumes.overlays[imageIdx];
        if (ovlData && this.showOverlay) {
            let ovlSlice = extractSlice(ovlData, this.config.shape, view, this.pos, this.viewport);
            let ovlSliceData = ovlSlice.data;

            if (this.showContour) {
                ovlSliceData = findBoundaries(ovlSliceData, ovlSlice.width, ovlSlice.height);
            }

            const ovlLut = getLUT(this.overlayColormaps[imageIdx] || "rainbow");
            const ovlRange = this.overlayRanges[imageIdx] || [0, 1];
            const ovlImageData = renderOverlayToImageData(ovlSliceData, ovlSlice.width, ovlSlice.height, ovlLut, ovlRange[0], ovlRange[1], this.alpha);

            const ovlTempCanvas = document.createElement("canvas");
            ovlTempCanvas.width = sliceW;
            ovlTempCanvas.height = sliceH;
            const ovlTempCtx = ovlTempCanvas.getContext("2d")!;
            ovlTempCtx.putImageData(ovlImageData, 0, 0);

            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(ovlTempCanvas, dx, dy, dw, dh);
        }

        // ── Crosshairs ────────────────────────────────────────────────
        if (this.showCrosshairs) {
            const chPos = getCrosshairPos(view, this.viewport, this.pos);
            const cx = dx + (chPos[0] + 0.5) * scaleX;
            const cy = dy + (chPos[1] + 0.5) * scaleY;
            const gap = this.fullCrosshairs ? 0 : 10 * Math.min(scaleX, scaleY);

            ctx.strokeStyle = this.crosshairColor;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 4]);
            ctx.globalAlpha = 0.9;

            // Vertical line
            ctx.beginPath();
            if (this.fullCrosshairs) {
                ctx.moveTo(cx, dy); ctx.lineTo(cx, dy + dh);
            } else {
                ctx.moveTo(cx, dy); ctx.lineTo(cx, cy - gap);
                ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, dy + dh);
            }
            ctx.stroke();

            // Horizontal line
            ctx.beginPath();
            if (this.fullCrosshairs) {
                ctx.moveTo(dx, cy); ctx.lineTo(dx + dw, cy);
            } else {
                ctx.moveTo(dx, cy); ctx.lineTo(cx - gap, cy);
                ctx.moveTo(cx + gap, cy); ctx.lineTo(dx + dw, cy);
            }
            ctx.stroke();

            ctx.setLineDash([]);
            ctx.globalAlpha = 1.0;

            // Value/coords display
            const shouldShowValue = this.view !== "multiplanar" || view === "axial";
            if (shouldShowValue) {
                const valueFs = 15;
                ctx.font = `600 ${valueFs}px monospace`;
                ctx.textAlign = "right";
                ctx.textBaseline = "bottom";
                ctx.strokeStyle = "black";
                ctx.lineWidth = 2.5;

                const imgVal = this._getVoxelValue(this.volumes.imgF32[imageIdx], this.pos);
                let valStr = this._formatValue(imgVal);
                if (ovlData) {
                    valStr += ` (${this._formatValue(this._getVoxelValue(ovlData, this.pos))})`;
                }

                const valY = dy + dh - valueFs * 0.35;
                ctx.strokeText(valStr, dx + dw - valueFs * 0.35, valY);
                ctx.fillStyle = this.crosshairColor;
                ctx.fillText(valStr, dx + dw - valueFs * 0.35, valY);
            }

            // Anatomical labels
            const labels = ANAT_LABELS[view];
            if (labels) {
                const labelFs = 14;
                ctx.font = `500 ${labelFs}px sans-serif`;
                ctx.textAlign = "center";
                ctx.fillStyle = "gold";
                ctx.strokeStyle = "black";
                ctx.lineWidth = 2;

                const positions: [number, number, CanvasTextAlign][] = [
                    [dx + dw / 2, dy + labelFs,             "center"],
                    [dx + dw / 2, dy + dh - labelFs * 0.3,  "center"],
                    [dx + labelFs * 0.75, dy + dh / 2,       "left"],
                    [dx + dw - labelFs * 0.75, dy + dh / 2,  "right"],
                ];
                for (let i = 0; i < 4; i++) {
                    const [x, y, align] = positions[i];
                    ctx.textAlign = align;
                    ctx.strokeText(labels[i], x, y);
                    ctx.fillText(labels[i], x, y);
                }
            }
        }

        // ── Bounding box ──────────────────────────────────────────────
        if (this.showBoundingBox && this.boundingBox) {
            const bb = this.boundingBox as unknown as [number, number][];
            const vp = this.viewport;
            let bx: number, by: number, bw: number, bh: number;

            switch (view) {
                case "axial":
                    bx = (bb[0][0] - vp[0][0]) * scaleX + dx;
                    by = (bb[1][0] - vp[1][0]) * scaleY + dy;
                    bw = (bb[0][1] - bb[0][0]) * scaleX;
                    bh = (bb[1][1] - bb[1][0]) * scaleY;
                    break;
                case "sagittal":
                    bx = (bb[1][0] - vp[1][0]) * scaleX + dx;
                    by = (bb[2][0] - vp[2][0]) * scaleY + dy;
                    bw = (bb[1][1] - bb[1][0]) * scaleX;
                    bh = (bb[2][1] - bb[2][0]) * scaleY;
                    break;
                case "coronal":
                    bx = (bb[0][0] - vp[0][0]) * scaleX + dx;
                    by = (bb[2][0] - vp[2][0]) * scaleY + dy;
                    bw = (bb[0][1] - bb[0][0]) * scaleX;
                    bh = (bb[2][1] - bb[2][0]) * scaleY;
                    break;
            }

            ctx.strokeStyle = "cyan";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.globalAlpha = 0.9;
            ctx.strokeRect(bx!, by!, bw!, bh!);
            ctx.globalAlpha = 1.0;
        }
    }

    _getVoxelValue(data: Float32Array, pos: number[]): number {
        const [D0, D1, D2] = this.config.shape;
        return data[pos[0] * D1 * D2 + pos[1] * D2 + pos[2]];
    }

    _formatValue(val: number): string {
        if (val === undefined || val === null || isNaN(val)) return "-";
        if (Number.isInteger(val)) return String(val);
        return val.toFixed(2).replace(/\.?0+$/, "");
    }

    exportPNG(): string {
        const { grid_dims } = this.config;
        const panelW = this.panels[0]?.w || 200;
        const panelH = this.panels[0]?.h || 200;
        const totalW = panelW * grid_dims[1];
        const panelsH = panelH * grid_dims[0];
        const captionH = this.caption ? 24 : 0;
        const totalH = panelsH + captionH;

        const compositeCanvas = document.createElement("canvas");
        compositeCanvas.width = totalW;
        compositeCanvas.height = totalH;
        const compCtx = compositeCanvas.getContext("2d")!;

        compCtx.fillStyle = "#000000";
        compCtx.fillRect(0, 0, totalW, totalH);

        for (let i = 0; i < this.panels.length; i++) {
            const row = Math.floor(i / grid_dims[1]);
            const col = i % grid_dims[1];
            const dx = col * panelW;
            const dy = row * panelH;
            compCtx.drawImage(this.panels[i].canvas, dx, dy, panelW, panelH);

            const title = this.config.titles[i];
            if (title) {
                const tfs = Math.max(10, Math.round(panelW * 0.05));
                compCtx.font = `bold ${tfs}px sans-serif`;
                compCtx.textAlign = "center";
                compCtx.textBaseline = "top";
                compCtx.strokeStyle = "black";
                compCtx.lineWidth = 3;
                compCtx.strokeText(title, dx + panelW / 2, dy + tfs * 0.25);
                compCtx.fillStyle = "#ffffff";
                compCtx.fillText(title, dx + panelW / 2, dy + tfs * 0.25);
            }
        }

        if (this.caption) {
            compCtx.fillStyle = "#ffffff";
            compCtx.font = `${Math.max(10, Math.round(panelW * 0.05))}px sans-serif`;
            compCtx.textAlign = "center";
            compCtx.textBaseline = "middle";
            compCtx.fillText(this.caption, totalW / 2, panelsH + captionH / 2);
        }

        return compositeCanvas.toDataURL("image/png");
    }
}
