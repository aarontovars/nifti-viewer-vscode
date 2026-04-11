// ════════════════════════════════════════════════════════════════════════
//  Slice extraction and contour detection
// ════════════════════════════════════════════════════════════════════════

import type { SingleView, Viewport, SliceResult } from "./types";

export function getSliceDims(shape: [number, number, number], view: SingleView, viewport: Viewport): [number, number] {
    switch (view) {
        case "axial":    return [viewport[0][1] - viewport[0][0], viewport[1][1] - viewport[1][0]];
        case "sagittal": return [viewport[1][1] - viewport[1][0], viewport[2][1] - viewport[2][0]];
        case "coronal":  return [viewport[0][1] - viewport[0][0], viewport[2][1] - viewport[2][0]];
    }
}

export function extractSlice(data: Float32Array, shape: [number, number, number], view: SingleView, pos: number[], viewport: Viewport): SliceResult {
    const [D0, D1, D2] = shape;
    const dims = getSliceDims(shape, view, viewport);
    const [w, h] = dims;
    const slice = new Float32Array(w * h);

    switch (view) {
        case "axial": {
            const z = pos[2];
            for (let y = 0; y < h; y++) {
                const pa = viewport[1][0] + y;
                for (let x = 0; x < w; x++) {
                    const lr = viewport[0][0] + x;
                    slice[y * w + x] = data[lr * D1 * D2 + pa * D2 + z];
                }
            }
            break;
        }
        case "sagittal": {
            const x0 = pos[0];
            for (let y = 0; y < h; y++) {
                const si = viewport[2][0] + y;
                for (let x = 0; x < w; x++) {
                    const pa = viewport[1][0] + x;
                    slice[y * w + x] = data[x0 * D1 * D2 + pa * D2 + si];
                }
            }
            break;
        }
        case "coronal": {
            const y0 = pos[1];
            for (let y = 0; y < h; y++) {
                const si = viewport[2][0] + y;
                for (let x = 0; x < w; x++) {
                    const lr = viewport[0][0] + x;
                    slice[y * w + x] = data[lr * D1 * D2 + y0 * D2 + si];
                }
            }
            break;
        }
    }
    return { data: slice, width: w, height: h };
}

export function findBoundaries(slice: Float32Array, width: number, height: number): Float32Array {
    const result = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const val = Math.round(slice[idx]);
            if (val === 0) continue;
            let isBoundary = false;
            if (x === 0 || x === width - 1 || y === 0 || y === height - 1) isBoundary = true;
            if (!isBoundary && x > 0 && Math.round(slice[idx - 1]) !== val) isBoundary = true;
            if (!isBoundary && x < width - 1 && Math.round(slice[idx + 1]) !== val) isBoundary = true;
            if (!isBoundary && y > 0 && Math.round(slice[idx - width]) !== val) isBoundary = true;
            if (!isBoundary && y < height - 1 && Math.round(slice[idx + width]) !== val) isBoundary = true;
            if (isBoundary) result[idx] = val;
        }
    }
    return result;
}
