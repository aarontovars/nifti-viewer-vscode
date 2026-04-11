// ════════════════════════════════════════════════════════════════════════
//  Rendering functions
// ════════════════════════════════════════════════════════════════════════

import type { SingleView, Viewport } from "./types";

export function renderSliceToImageData(sliceData: Float32Array, width: number, height: number, lut: Uint8Array, vmin: number, vmax: number): ImageData {
    const imageData = new ImageData(width, height);
    const pixels = imageData.data;
    const scale = vmax > vmin ? 255 / (vmax - vmin) : 0;

    for (let i = 0; i < width * height; i++) {
        let idx = Math.round((sliceData[i] - vmin) * scale);
        idx = Math.max(0, Math.min(255, idx));
        const p = i * 4;
        pixels[p] = lut[idx * 4];
        pixels[p + 1] = lut[idx * 4 + 1];
        pixels[p + 2] = lut[idx * 4 + 2];
        pixels[p + 3] = 255;
    }
    return imageData;
}

export function renderOverlayToImageData(sliceData: Float32Array, width: number, height: number, lut: Uint8Array, vmin: number, vmax: number, alpha: number): ImageData {
    const imageData = new ImageData(width, height);
    const pixels = imageData.data;
    const scale = vmax > vmin ? 255 / (vmax - vmin) : 0;

    for (let i = 0; i < width * height; i++) {
        const val = sliceData[i];
        const p = i * 4;
        if (val === 0 || isNaN(val) || val < vmin || val > vmax) {
            pixels[p + 3] = 0;
        } else {
            let idx = Math.round((val - vmin) * scale);
            idx = Math.max(0, Math.min(255, idx));
            pixels[p] = lut[idx * 4];
            pixels[p + 1] = lut[idx * 4 + 1];
            pixels[p + 2] = lut[idx * 4 + 2];
            pixels[p + 3] = Math.round(alpha * 255);
        }
    }
    return imageData;
}

export function getAspectRatio(voxelSizes: [number, number, number], view: SingleView): number {
    switch (view) {
        case "axial":    return voxelSizes[1] / voxelSizes[0];
        case "sagittal": return voxelSizes[2] / voxelSizes[1];
        case "coronal":  return voxelSizes[2] / voxelSizes[0];
    }
}

export function getCrosshairPos(view: SingleView, viewport: Viewport, pos: number[]): [number, number] {
    switch (view) {
        case "axial":    return [pos[0] - viewport[0][0], pos[1] - viewport[1][0]];
        case "sagittal": return [pos[1] - viewport[1][0], pos[2] - viewport[2][0]];
        case "coronal":  return [pos[0] - viewport[0][0], pos[2] - viewport[2][0]];
    }
}

export function computeViewport(shape: [number, number, number], pos: number[], zoomFactor: number): Viewport {
    const viewport: Viewport = [];
    for (let d = 0; d < 3; d++) {
        const span = Math.round(shape[d] / zoomFactor);
        let start = pos[d] - Math.floor(span / 2);
        let end = pos[d] + Math.ceil(span / 2);
        if (start < 0) { end = Math.min(shape[d], end - start); start = 0; }
        if (end > shape[d]) { start = Math.max(0, start - (end - shape[d])); end = shape[d]; }
        viewport.push([start, end]);
    }
    return viewport;
}

export const ANAT_LABELS: Record<SingleView, [string, string, string, string]> = {
    axial:    ["A", "P", "R", "L"],
    coronal:  ["S", "I", "R", "L"],
    sagittal: ["S", "I", "A", "P"],
};
