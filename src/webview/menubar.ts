import type { VscodeViewer } from "./vscodeViewer";

const COLORMAPS = [
  "gray", "hot", "hot_r", "jet", "rainbow", "viridis",
  "Reds", "Greens", "bwr", "autumn", "BuPu", "PuOr", "Pastel1", "tab20", "discrete",
];

interface MenuBarCallbacks {
  onLoadImage: () => void;
  onAddImage: () => void;
  onOpenNewTab: () => void;
  onLoadOverlay: () => void;
  onChanged: () => void;
}

let activeMenu: HTMLElement | null = null;
function closeMenus(): void {
  if (activeMenu) { activeMenu.classList.remove("open"); activeMenu = null; }
}

export function buildMenuBar(
  bar: HTMLElement,
  filename: string,
  viewer: VscodeViewer,
  cb: MenuBarCallbacks
): void {
  bar.innerHTML = "";
  document.removeEventListener("click", closeMenus);
  document.addEventListener("click", closeMenus);

  // ── Add Image ──
  const addImg = menu(bar, "Add Image");
  action(addImg.drop, "Open Image\u2026", () => cb.onLoadImage());
  action(addImg.drop, "Add Side-by-Side\u2026  (Shift+F)", () => cb.onAddImage());
  action(addImg.drop, "Open in New Tab\u2026", () => cb.onOpenNewTab());

  // ── View ──
  const viewMenu = menu(bar, "View");
  for (const v of ["Axial", "Sagittal", "Coronal", "Multiplanar"] as const) {
    const key = v.toLowerCase();
    toggle(viewMenu.drop, `${v}  (${v[0]})`, viewer.view === key, () => {
      viewer.view = key as any;
      if (key !== "multiplanar") viewer.focusedView = key as any;
      viewer.render(); cb.onChanged();
    });
  }
  sep(viewMenu.drop);
  toggle(viewMenu.drop, "Interpolation  (i)", viewer.smoothInterp, () => {
    viewer.smoothInterp = !viewer.smoothInterp; viewer.render(); cb.onChanged();
  });
  toggle(viewMenu.drop, "Crosshair  (x)", viewer.showCrosshairs, () => {
    viewer.showCrosshairs = !viewer.showCrosshairs; viewer.render(); cb.onChanged();
  });
  toggle(viewMenu.drop, "Full Crosshair  (f)", viewer.fullCrosshairs, () => {
    viewer.fullCrosshairs = !viewer.fullCrosshairs; viewer.render(); cb.onChanged();
  });

  // ── ColorScale ──
  const csMenu = menu(bar, "ColorScale");
  for (const cm of COLORMAPS) {
    toggle(csMenu.drop, cm, viewer.imageColormaps[0] === cm, () => {
      viewer.imageColormaps = [cm]; viewer.render(); cb.onChanged();
    });
  }
  sep(csMenu.drop);
  toggle(csMenu.drop, "Auto Range  (r)", viewer.autoRange, () => {
    viewer.toggleAutoRange(); cb.onChanged();
  });
  sep(csMenu.drop);
  const range = viewer.getDisplayRange();
  const full = viewer.getFullRange();
  slider(csMenu.drop, "Min", full[0], full[1], range[0], (v) => {
    const r = viewer.getDisplayRange(); viewer.setDisplayRange(v, r[1]);
  });
  slider(csMenu.drop, "Max", full[0], full[1], range[1], (v) => {
    const r = viewer.getDisplayRange(); viewer.setDisplayRange(r[0], v);
  });

  // ── Overlay ──
  const ovlMenu = menu(bar, "Overlay");
  action(ovlMenu.drop, "Add Overlay\u2026  (Shift+O)", () => cb.onLoadOverlay());
  sep(ovlMenu.drop);
  toggle(ovlMenu.drop, "Show  (w)", viewer.showOverlay, () => {
    viewer.showOverlay = !viewer.showOverlay; viewer.render(); cb.onChanged();
  });
  toggle(ovlMenu.drop, `Contour  (c) [${viewer.contourCycleState}]`, viewer.contourCycleState === "all-contour", () => {
    const cycle: Array<"template" | "all-contour" | "all-filled"> = ["template", "all-contour", "all-filled"];
    const ci = cycle.indexOf(viewer.contourCycleState);
    viewer.contourCycleState = cycle[(ci + 1) % cycle.length];
    viewer.showContour = viewer.contourCycleState === "all-contour";
    viewer.render(); cb.onChanged();
  });
  sep(ovlMenu.drop);
  for (const cm of COLORMAPS) {
    toggle(ovlMenu.drop, cm, viewer.overlayColormaps[0] === cm, () => {
      viewer.overlayColormaps = [cm]; viewer.render(); cb.onChanged();
    });
  }
  sep(ovlMenu.drop);
  action(ovlMenu.drop, "Auto Range  (Shift+R)", () => {
    viewer.resetOverlayRange(); cb.onChanged();
  });
  sep(ovlMenu.drop);
  const ovlRange = viewer.getOverlayRange();
  const ovlFull = viewer.getOverlayFullRange();
  slider(ovlMenu.drop, "Min", ovlFull[0], ovlFull[1], ovlRange[0], (v) => {
    const r = viewer.getOverlayRange(); viewer.setOverlayRange(v, r[1]);
  });
  slider(ovlMenu.drop, "Max", ovlFull[0], ovlFull[1], ovlRange[1], (v) => {
    const r = viewer.getOverlayRange(); viewer.setOverlayRange(r[0], v);
  });

  // ── Mask & Labels ──
  const allOvl = viewer.getAllOverlayInfo();
  const activeIdx = viewer.activeMaskGlobalIdx;
  const activeOvlInfo = allOvl[activeIdx];
  const labels = activeOvlInfo ? activeOvlInfo.labels : [];

  // Mask menu (only when 2+ overlays)
  if (allOvl.length > 1) {
    const maskMenu = menu(bar, `Mask (${activeIdx + 1})`);
    for (let i = 0; i < allOvl.length; i++) {
      const info = allOvl[i];
      const lbl = info.labels.length > 0 ? `  ${info.labels.length} labels` : "";
      toggle(maskMenu.drop, `${info.name}${lbl}`, i === activeIdx, () => {
        viewer.setMaskIndex(i); cb.onChanged();
      });
    }
  }

  // Labels menu (if selected mask has labels)
  if (labels.length > 0) {
    const lblTitle = viewer.currentLabel !== null
      ? `Labels (${viewer.currentLabel}/${labels.length})`
      : `Labels (${labels.length})`;
    const lblMenu = menu(bar, lblTitle);
    lblMenu.drop.style.maxHeight = "300px";
    lblMenu.drop.style.overflowY = "auto";
    const header = document.createElement("div");
    header.className = "mn-item"; header.style.opacity = "0.5"; header.style.cursor = "default";
    header.textContent = `${labels.length} labels  \u2190 p / n \u2192`;
    lblMenu.drop.appendChild(header);
    sep(lblMenu.drop);
    for (const lbl of labels) {
      toggle(lblMenu.drop, `Label ${lbl}`, viewer.currentLabel === lbl, () => {
        viewer.navigateToLabel(lbl); cb.onChanged();
      });
    }
  }

  // ── Right side info ──
  const info = document.createElement("span");
  info.className = "menubar-filename";
  const viewName = viewer.view.charAt(0).toUpperCase() + viewer.view.slice(1);
  const imgCount = viewer.slotCount > 1 ? ` [${viewer.slotCount}]` : "";
  const lblInfo = viewer.currentLabel !== null ? ` L:${viewer.currentLabel}` : "";
  info.textContent = `${viewName}${imgCount}${lblInfo} \u2014 ${filename}`;
  info.title = filename;
  bar.appendChild(info);
}

// ── Helpers ──────────────────────────────────────────────────────────

function menu(bar: HTMLElement, label: string): { el: HTMLElement; drop: HTMLElement } {
  const el = document.createElement("div");
  el.className = "mn";
  const btn = document.createElement("button");
  btn.className = "mn-trigger";
  btn.innerHTML = `${label} <span class="mn-chev">\u25BE</span>`;
  el.appendChild(btn);
  const drop = document.createElement("div");
  drop.className = "mn-drop";
  el.appendChild(drop);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (el.classList.contains("open")) closeMenus();
    else { closeMenus(); el.classList.add("open"); activeMenu = el; }
  });
  btn.addEventListener("mouseenter", () => {
    if (activeMenu && activeMenu !== el) { closeMenus(); el.classList.add("open"); activeMenu = el; }
  });
  bar.appendChild(el);
  return { el, drop };
}

function action(drop: HTMLElement, label: string, onClick: () => void): void {
  const btn = document.createElement("button");
  btn.className = "mn-item";
  btn.textContent = label;
  btn.addEventListener("click", (e) => { e.stopPropagation(); closeMenus(); onClick(); });
  drop.appendChild(btn);
}

function toggle(drop: HTMLElement, label: string, active: boolean, onClick: () => void): void {
  const btn = document.createElement("button");
  btn.className = "mn-item";
  if (active) btn.classList.add("mn-active");
  btn.innerHTML = `<span class="mn-check">${active ? "\u2713" : ""}</span>${label}`;
  btn.addEventListener("click", (e) => { e.stopPropagation(); closeMenus(); onClick(); });
  drop.appendChild(btn);
}

function sep(drop: HTMLElement): void {
  const el = document.createElement("div");
  el.className = "mn-sep";
  drop.appendChild(el);
}

function slider(drop: HTMLElement, label: string, min: number, max: number, value: number, onChange: (v: number) => void): void {
  const row = document.createElement("div");
  row.className = "mn-slider-row";
  const lbl = document.createElement("label");
  lbl.textContent = label;
  row.appendChild(lbl);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min); input.max = String(max);
  input.step = String((max - min) / 200 || 0.01);
  input.value = String(value);
  row.appendChild(input);
  const val = document.createElement("span");
  val.className = "mn-slider-val";
  val.textContent = value.toFixed(1);
  row.appendChild(val);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value); val.textContent = v.toFixed(1); onChange(v);
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  drop.appendChild(row);
}
