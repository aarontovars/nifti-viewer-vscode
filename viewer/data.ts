// ════════════════════════════════════════════════════════════════════════
//  Data unpacking
// ════════════════════════════════════════════════════════════════════════

import type { ViewerConfig, Volumes } from "./types";

export function dequantizeU8(u8view: Uint8Array, offset: number, count: number, scale: [number, number]): Float32Array {
    const [vmin, vmax] = scale;
    const f32 = new Float32Array(count);
    const range = vmax - vmin;
    if (range > 0) {
        const inv = range / 255.0;
        for (let j = 0; j < count; j++) {
            f32[j] = u8view[offset + j] * inv + vmin;
        }
    } else {
        f32.fill(vmin);
    }
    return f32;
}

export function unpackVolumes(u8: Uint8Array, config: ViewerConfig): Volumes {
    const shape = config.shape;
    const voxelCount = shape[0] * shape[1] * shape[2];

    const imgIdx = config.image_buffer_indices;
    const ovlIdx = config.overlay_buffer_indices;
    const hasDedupIdx = Array.isArray(imgIdx);

    const slotCache = new Map<number, Float32Array>();

    const isIntegerImg = config.image_is_integer || [];
    const images: Float32Array[] = [];
    for (let i = 0; i < config.n_images; i++) {
        const slot = hasDedupIdx ? imgIdx[i] : i;
        if (!slotCache.has(slot)) {
            const f32 = dequantizeU8(u8, slot * voxelCount, voxelCount, config.image_pack_scales[i]);
            if (isIntegerImg[i]) {
                for (let j = 0; j < f32.length; j++) f32[j] = Math.round(f32[j]);
            }
            slotCache.set(slot, f32);
        }
        images.push(slotCache.get(slot)!);
    }

    const isIntegerOvl = config.overlay_is_integer || [];
    let legacyOvlSlot = config.n_images;
    const overlays: (Float32Array | null)[] = [];
    for (let i = 0; i < config.n_overlays; i++) {
        if (config.overlay_has_data[i]) {
            const slot = hasDedupIdx ? ovlIdx[i] : legacyOvlSlot++;
            if (!slotCache.has(slot)) {
                const f32 = dequantizeU8(u8, slot * voxelCount, voxelCount, config.overlay_pack_scales[i]);
                if (isIntegerOvl[i] !== false) {
                    for (let j = 0; j < f32.length; j++) f32[j] = Math.round(f32[j]);
                }
                slotCache.set(slot, f32);
            }
            overlays.push(slotCache.get(slot)!);
        } else {
            overlays.push(null);
        }
    }

    return { images, overlays, imgF32: [] };
}

export function unpackF32Images(u8f32: Uint8Array, config: ViewerConfig): Float32Array[] {
    const shape = config.shape;
    const voxelCount = shape[0] * shape[1] * shape[2];
    const imgIdx = config.image_buffer_indices;
    const slotCache = new Map<number, Float32Array>();
    const images: Float32Array[] = [];
    for (let i = 0; i < config.n_images; i++) {
        const slot = imgIdx[i];
        if (!slotCache.has(slot)) {
            const byteOffset = u8f32.byteOffset + slot * voxelCount * 4;
            slotCache.set(slot, new Float32Array(u8f32.buffer, byteOffset, voxelCount));
        }
        images.push(slotCache.get(slot)!);
    }
    return images;
}

export async function decompressZlib(compressed: Uint8Array): Promise<Uint8Array> {
    try {
        const ds = new DecompressionStream("deflate");
        const decompressed = await new Response(
            new Blob([compressed]).stream().pipeThrough(ds)
        ).arrayBuffer();
        return new Uint8Array(decompressed);
    } catch {
        return new Uint8Array(
            compressed.buffer || compressed,
            compressed.byteOffset || 0,
            compressed.byteLength,
        );
    }
}
