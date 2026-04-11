// ════════════════════════════════════════════════════════════════════════
//  Type definitions for the NIfTI Viewer
// ════════════════════════════════════════════════════════════════════════

export type ViewType = "axial" | "sagittal" | "coronal" | "multiplanar";
export type SingleView = "axial" | "sagittal" | "coronal";

export type Viewport = [number, number][];  // [[start, end], [start, end], [start, end]]

export interface BoundingBox {
    [dim: number]: [number, number];
}

export interface SliceResult {
    data: Float32Array;
    width: number;
    height: number;
}

export interface ViewRegion {
    dx: number;
    dy: number;
    dw: number;
    dh: number;
    sliceW: number;
    sliceH: number;
    scaleX: number;
    scaleY: number;
    regionX: number;
    regionY: number;
    regionW: number;
    regionH: number;
}

export interface Volumes {
    images: Float32Array[];
    overlays: (Float32Array | null)[];
    imgF32: Float32Array[];
}

export interface Panel {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    panelDiv: HTMLElement;
    imageIdx: number;
    w: number;
    h: number;
}

export interface SliderControl {
    container: HTMLElement;
    input: HTMLInputElement;
    valSpan: HTMLSpanElement;
}

export interface RangeSliderControl {
    container: HTMLElement;
    inputLo: HTMLInputElement;
    inputHi: HTMLInputElement;
    valLoSpan: HTMLSpanElement;
    valHiSpan: HTMLSpanElement;
}

export interface DropdownControl {
    container: HTMLElement;
    select: HTMLSelectElement;
}

export interface CheckboxControl {
    container: HTMLElement;
    input: HTMLInputElement;
}

export interface ViewerControls {
    sliderLR: SliderControl;
    sliderPA: SliderControl;
    sliderIS: SliderControl;
    viewDropdown: DropdownControl;
    imgCmapDropdown: DropdownControl;
    exportBtn: HTMLButtonElement;
    saveBtn: HTMLButtonElement;
    showOverlay: CheckboxControl;
    showContour: CheckboxControl;
    showBBox: CheckboxControl;
    alphaSlider: SliderControl;
    ovlCmapDropdown: DropdownControl;
    zoomSlider: SliderControl;
    percentileRange: RangeSliderControl;
    autoRangeBtn: HTMLButtonElement;
    showCrosshairs: CheckboxControl;
    fullCrosshairs: CheckboxControl;
    smoothInterp: CheckboxControl;
    crosshairColorDropdown: DropdownControl;
    configOutput: HTMLElement;
    prevBtn: HTMLButtonElement;
    nextBtn: HTMLButtonElement;
    maskDropdown: DropdownControl;
    lesionDropdown: DropdownControl;
    predLabel: HTMLSpanElement;
    classDropdown: DropdownControl;
    saveClassBtn: HTMLButtonElement;
    saveClassLabel: HTMLSpanElement;
}

export interface ClassificationFinding {
    lesion_id?: string;
    id_json_nel?: string;
    pred_class?: string;
    true_class?: string;
    [key: string]: unknown;
}

export interface ClassificationData {
    findings?: ClassificationFinding[];
    [key: string]: unknown;
}

export interface ViewerConfig {
    shape: [number, number, number];
    voxel_sizes: [number, number, number];
    initial_pos: [number, number, number];
    initial_pos_ras: [number, number, number];
    visualization: ViewType;
    zoom_factor: number;
    alpha: number;
    show_overlays: boolean;
    show_contour: boolean;
    show_crosshairs: boolean;
    full_crosshairs: boolean;
    show_bounding_box: boolean;
    crosshairs_color: string;
    images_colormaps: string[];
    overlays_colormaps: string[];
    percentile: number;
    auto_range: boolean;
    auto_range_percentile: number;
    auto_range_lo_percentile: number;
    bbox_margin: number;
    caption: string | null;
    n_images: number;
    n_overlays: number;
    grid_dims: [number, number];
    grid_dims_explicit: boolean;
    max_width: number | null;
    titles: (string | null)[];
    image_ranges: [number, number][];
    overlay_ranges: ([number, number] | null)[];
    image_pack_scales: [number, number][];
    overlay_pack_scales: [number, number][];
    overlay_has_data: boolean[];
    overlay_is_integer: boolean[];
    image_is_integer: boolean[];
    image_buffer_indices: number[];
    overlay_buffer_indices: number[];
    overlay_labels_centers: (Record<string, [number, number, number]> | null)[];
    labels_properties: (Record<string, string> | null)[];
    precomputed_bboxes: (Record<string, [[number, number], [number, number], [number, number]]> | null)[];
    mask_index: number | null;
    lesion_index: number | null;
    disable_lesions_viewer: boolean;
    percentile_lut: ({ hi: Record<string, number>; lo: Record<string, number> } | null)[];
    classification_data: ClassificationData | null;
    classification_options: string[];
    classification_file: string;
    images_str: string | null;
    overlays_str: string | null;
    _container_width: number;
}

export interface AnyWidgetModel {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    on(event: string, callback: (...args: unknown[]) => void): void;
    off(event: string, callback: (...args: unknown[]) => void): void;
    save_changes(): void;
}

export type ColormapFn = (t: number) => [number, number, number];

// DecompressionStream may not be in all DOM lib versions
declare global {
    class DecompressionStream {
        constructor(format: string);
        readonly readable: ReadableStream;
        readonly writable: WritableStream;
    }
}
