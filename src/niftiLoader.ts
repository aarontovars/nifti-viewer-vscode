import * as nifti from "nifti-reader-js";

export interface NiftiVolume {
  data: Float32Array;
  shape: [number, number, number];
  voxelSizes: [number, number, number];
  affine: number[][];
  /** Debug string with orientation info */
  orientDebug: string;
}

/**
 * Load NIfTI, reorient to viewer convention using NiiVue's algorithm.
 *
 * Viewer expects data in C-order (row-major) with axes:
 *   axis 0 (slowest): R→L  (index 0 = most Right)
 *   axis 1:           A→P  (index 0 = most Anterior)
 *   axis 2 (fastest): S→I  (index 0 = most Superior)
 *
 * NIfTI stores data in F-order (column-major, first dim fastest).
 */
export function loadNifti(fileBytes: Uint8Array): NiftiVolume {
  let buf: ArrayBuffer = new Uint8Array(fileBytes).buffer as ArrayBuffer;

  if (nifti.isCompressed(buf)) buf = nifti.decompress(buf);
  if (!nifti.isNIFTI(buf)) throw new Error("Not a valid NIfTI file");

  const hdr = nifti.readHeader(buf);
  if (!hdr) throw new Error("Failed to read NIfTI header");

  const raw = nifti.readImage(hdr, buf);
  const dims: [number, number, number] = [hdr.dims[1], hdr.dims[2], hdr.dims[3]];
  const pixDims: [number, number, number] = [
    Math.abs(hdr.pixDims[1]) || 1,
    Math.abs(hdr.pixDims[2]) || 1,
    Math.abs(hdr.pixDims[3]) || 1,
  ];

  const f32 = toFloat32(raw, hdr.datatypeCode);
  const affine = extractAffine(hdr);
  const result = reorient(f32, dims, pixDims, affine);

  return { ...result, affine };
}

// ── datatype conversion ──────────────────────────────────────────────

function toFloat32(buf: ArrayBuffer, code: number): Float32Array {
  switch (code) {
    case 2:   return new Float32Array(new Uint8Array(buf));
    case 4:   return new Float32Array(new Int16Array(buf));
    case 8:   return new Float32Array(new Int32Array(buf));
    case 16:  return new Float32Array(buf);
    case 64: {
      const f64 = new Float64Array(buf);
      const o = new Float32Array(f64.length);
      for (let i = 0; i < f64.length; i++) o[i] = f64[i];
      return o;
    }
    case 256: return new Float32Array(new Int8Array(buf));
    case 512: return new Float32Array(new Uint16Array(buf));
    case 768: return new Float32Array(new Uint32Array(buf));
    default:  throw new Error(`Unsupported NIfTI datatype: ${code}`);
  }
}

// ── affine extraction ────────────────────────────────────────────────

function extractAffine(hdr: any): number[][] {
  // Prefer sform
  if (hdr.sform_code > 0) {
    if (hdr.srow_x && hdr.srow_y && hdr.srow_z) {
      return [
        [hdr.srow_x[0], hdr.srow_x[1], hdr.srow_x[2], hdr.srow_x[3]],
        [hdr.srow_y[0], hdr.srow_y[1], hdr.srow_y[2], hdr.srow_y[3]],
        [hdr.srow_z[0], hdr.srow_z[1], hdr.srow_z[2], hdr.srow_z[3]],
        [0, 0, 0, 1],
      ];
    }
    if (hdr.affine) {
      return [
        [...hdr.affine[0]],
        [...hdr.affine[1]],
        [...hdr.affine[2]],
        [0, 0, 0, 1],
      ];
    }
  }

  // Qform fallback
  if (hdr.qform_code > 0) return qformToAffine(hdr);

  // Identity fallback
  return [
    [hdr.pixDims[1] || 1, 0, 0, 0],
    [0, hdr.pixDims[2] || 1, 0, 0],
    [0, 0, hdr.pixDims[3] || 1, 0],
    [0, 0, 0, 1],
  ];
}

function qformToAffine(hdr: any): number[][] {
  const b = hdr.quatern_b || 0;
  const c = hdr.quatern_c || 0;
  const d = hdr.quatern_d || 0;
  const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d));
  const qfac = (hdr.pixDims[0] < 0) ? -1 : 1;
  const di = Math.abs(hdr.pixDims[1]) || 1;
  const dj = Math.abs(hdr.pixDims[2]) || 1;
  const dk = (Math.abs(hdr.pixDims[3]) || 1) * qfac;

  return [
    [(a*a+b*b-c*c-d*d)*di, 2*(b*c-a*d)*dj,       2*(b*d+a*c)*dk,       hdr.qoffset_x||0],
    [2*(b*c+a*d)*di,       (a*a+c*c-b*b-d*d)*dj,  2*(c*d-a*b)*dk,       hdr.qoffset_y||0],
    [2*(b*d-a*c)*di,       2*(c*d+a*b)*dj,         (a*a+d*d-b*b-c*c)*dk, hdr.qoffset_z||0],
    [0, 0, 0, 1],
  ];
}

// ── NiiVue-style reorientation ───────────────────────────────────────
//
// Key insight: NIfTI data is F-order (first dim fastest), but the viewer's
// extractSlice reads in C-order (first dim slowest: data[x*D1*D2 + y*D2 + z]).
//
// So the reorientation must:
// 1. Read input using F-order strides (correct for NIfTI data)
// 2. Write output in C-order (x=outer loop, z=inner loop)

function reorient(
  data: Float32Array,
  dims: [number, number, number],
  pixDims: [number, number, number],
  affine: number[][]
): { data: Float32Array; shape: [number, number, number]; voxelSizes: [number, number, number]; orientDebug: string } {

  // affine[row][col]: row = physical axis (0=R, 1=A, 2=S), col = storage axis (i,j,k)
  const rot = [
    [affine[0][0], affine[0][1], affine[0][2]],
    [affine[1][0], affine[1][1], affine[1][2]],
    [affine[2][0], affine[2][1], affine[2][2]],
  ];

  // For each output RAS axis, find best storage axis (greedy, largest absolute value)
  const perm: [number, number, number] = [0, 1, 2];
  const assignments: { rasAxis: number; storageAxis: number; val: number }[] = [];
  for (let r = 0; r < 3; r++) {
    for (let s = 0; s < 3; s++) {
      assignments.push({ rasAxis: r, storageAxis: s, val: Math.abs(rot[r][s]) });
    }
  }
  assignments.sort((a, b) => b.val - a.val);

  const rasUsed = [false, false, false];
  const storUsed = [false, false, false];
  for (const a of assignments) {
    if (rasUsed[a.rasAxis] || storUsed[a.storageAxis]) continue;
    perm[a.rasAxis] = a.storageAxis;
    rasUsed[a.rasAxis] = true;
    storUsed[a.storageAxis] = true;
  }

  // Viewer wants "reversed RAS": index 0 = most R/A/S, index max = most L/P/I
  // So flip if the storage axis goes in positive RAS direction (val > 0),
  // meaning high storage index = most R/A/S — we need to reverse.
  const flip: [boolean, boolean, boolean] = [false, false, false];
  for (let r = 0; r < 3; r++) {
    flip[r] = rot[r][perm[r]] > 0;
  }

  const outDims: [number, number, number] = [dims[perm[0]], dims[perm[1]], dims[perm[2]]];
  const outVox: [number, number, number] = [pixDims[perm[0]], pixDims[perm[1]], pixDims[perm[2]]];

  // NIfTI F-order input strides: storage axis 0 = stride 1 (fastest)
  const inStride = [1, dims[0], dims[0] * dims[1]];

  // Build per-axis stride and start for the input (F-order)
  const axStride: [number, number, number] = [
    inStride[perm[0]],
    inStride[perm[1]],
    inStride[perm[2]],
  ];
  const axStart: [number, number, number] = [0, 0, 0];
  for (let p = 0; p < 3; p++) {
    if (flip[p]) {
      axStart[p] = axStride[p] * (outDims[p] - 1);
      axStride[p] = -axStride[p];
    }
  }

  // Write output in C-ORDER (axis 0 = slowest/outer, axis 2 = fastest/inner)
  // This matches the viewer's data[x * D1 * D2 + y * D2 + z] access pattern
  const out = new Float32Array(data.length);
  let j = 0;
  for (let x = 0; x < outDims[0]; x++) {
    const xi = axStart[0] + x * axStride[0];
    for (let y = 0; y < outDims[1]; y++) {
      const yi = axStart[1] + y * axStride[1];
      for (let z = 0; z < outDims[2]; z++) {
        const zi = axStart[2] + z * axStride[2];
        out[j++] = data[xi + yi + zi];
      }
    }
  }

  const axNames = ["R/L", "A/P", "S/I"];
  const orientDebug = `perm=[${perm}] flip=[${flip.map(f=>f?'Y':'N')}] ` +
    `storage→RAS: i→${axNames[perm.indexOf(0)]}, j→${axNames[perm.indexOf(1)]}, k→${axNames[perm.indexOf(2)]}`;

  return { data: out, shape: outDims, voxelSizes: outVox, orientDebug };
}

// ── public utilities ─────────────────────────────────────────────────

/** Compute robust display range using percentiles (like NiiVue). */
export function computeRange(data: Float32Array, loP = 0.01, hiP = 99.99): [number, number] {
  // Sample up to 100k values for speed
  const step = Math.max(1, Math.floor(data.length / 100000));
  const vals: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    if (!isNaN(data[i])) vals.push(data[i]);
  }
  if (vals.length === 0) return [0, 1];

  vals.sort((a, b) => a - b);

  const lo = vals[Math.floor(vals.length * loP / 100)];
  const hi = vals[Math.min(vals.length - 1, Math.ceil(vals.length * hiP / 100))];

  // If range is degenerate, fall back to full min/max
  if (lo >= hi) {
    return [vals[0], vals[vals.length - 1]];
  }
  return [lo, hi];
}

/** Full min/max range (no percentile clipping). */
export function computeFullRange(data: Float32Array): [number, number] {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!isNaN(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min === Infinity ? [0, 1] : [min, max];
}

export function isIntegerVolume(data: Float32Array): boolean {
  const step = Math.max(1, Math.floor(data.length / 10000));
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (v !== 0 && !isNaN(v) && v !== Math.floor(v)) return false;
  }
  return true;
}
