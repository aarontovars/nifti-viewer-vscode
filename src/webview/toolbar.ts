const VIEWS = ["axial", "coronal", "sagittal", "multiplanar"] as const;
const VIEW_SHORTCUTS: Record<string, string> = {
  axial: "A",
  coronal: "C",
  sagittal: "S",
  multiplanar: "M",
};

const COLORMAPS = [
  "gray", "hot", "hot_r", "jet", "rainbow", "viridis",
  "Reds", "Greens", "bwr", "autumn", "BuPu", "PuOr", "Pastel1", "tab20", "discrete",
];

export interface ToolbarCallbacks {
  onLoadOverlay: () => void;
  onViewChange: (view: string) => void;
  onImageColormapChange: (cmap: string) => void;
  onOverlayColormapChange: (cmap: string) => void;
  onCrosshairsToggle: () => void;
  onSmoothToggle: () => void;
}

export interface ToolbarState {
  currentView: string;
  currentImageCmap: string;
  currentOverlayCmap: string;
  showCrosshairs: boolean;
  smoothInterp: boolean;
}

let openMenu: HTMLElement | null = null;

function closeAllMenus(): void {
  if (openMenu) {
    openMenu.classList.remove("open");
    openMenu = null;
  }
}

function createMenuItem(label: string): { item: HTMLElement; trigger: HTMLButtonElement; dropdown: HTMLElement } {
  const item = document.createElement("div");
  item.className = "menu-item";

  const trigger = document.createElement("button");
  trigger.className = "menu-trigger";
  trigger.textContent = label;
  item.appendChild(trigger);

  const dropdown = document.createElement("div");
  dropdown.className = "menu-dropdown";
  item.appendChild(dropdown);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (item.classList.contains("open")) {
      closeAllMenus();
    } else {
      closeAllMenus();
      item.classList.add("open");
      openMenu = item;
    }
  });

  trigger.addEventListener("mouseenter", () => {
    if (openMenu && openMenu !== item) {
      closeAllMenus();
      item.classList.add("open");
      openMenu = item;
    }
  });

  return { item, trigger, dropdown };
}

function addAction(dropdown: HTMLElement, label: string, shortcut: string, onClick: () => void, opts?: { check?: boolean; active?: boolean }): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "menu-action";
  if (opts?.active) btn.classList.add("active");

  let inner = "";
  if (opts?.check !== undefined) {
    inner += `<span class="check">${opts.active ? "\u2713" : ""}</span>`;
  }
  inner += `<span>${label}</span>`;
  if (shortcut) {
    inner += `<span class="shortcut">${shortcut}</span>`;
  }
  btn.innerHTML = inner;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
    closeAllMenus();
  });

  dropdown.appendChild(btn);
  return btn;
}

function addSeparator(dropdown: HTMLElement): void {
  const sep = document.createElement("div");
  sep.className = "menu-separator";
  dropdown.appendChild(sep);
}

function addSelectRow(dropdown: HTMLElement, label: string, options: string[], selected: string, onChange: (val: string) => void): HTMLSelectElement {
  const row = document.createElement("div");
  row.className = "menu-select-row";

  const lbl = document.createElement("label");
  lbl.textContent = label;
  row.appendChild(lbl);

  const select = document.createElement("select");
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    if (opt === selected) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", () => {
    onChange(select.value);
  });
  // Prevent dropdown from closing when interacting with select
  select.addEventListener("click", (e) => e.stopPropagation());
  row.appendChild(select);

  dropdown.appendChild(row);
  return select;
}

export function buildToolbar(
  container: HTMLElement,
  filename: string,
  callbacks: ToolbarCallbacks,
  state: ToolbarState
): void {
  container.innerHTML = "";

  // Close menus on click outside
  document.addEventListener("click", closeAllMenus);

  // ── File menu ──
  const file = createMenuItem("File");
  addAction(file.dropdown, "Load Overlay...", "", callbacks.onLoadOverlay);
  container.appendChild(file.item);

  // ── View menu ──
  const view = createMenuItem("View");
  for (const v of VIEWS) {
    addAction(view.dropdown, v.charAt(0).toUpperCase() + v.slice(1), VIEW_SHORTCUTS[v], () => {
      callbacks.onViewChange(v);
    }, { check: true, active: v === state.currentView });
  }
  addSeparator(view.dropdown);
  addAction(view.dropdown, "Crosshairs", "X", () => {
    callbacks.onCrosshairsToggle();
  }, { check: true, active: state.showCrosshairs });
  addAction(view.dropdown, "Smooth interpolation", "I", () => {
    callbacks.onSmoothToggle();
  }, { check: true, active: state.smoothInterp });
  container.appendChild(view.item);

  // ── Colormap menu ──
  const cmap = createMenuItem("Colormap");
  addSelectRow(cmap.dropdown, "Image", COLORMAPS, state.currentImageCmap, callbacks.onImageColormapChange);
  addSeparator(cmap.dropdown);
  addSelectRow(cmap.dropdown, "Overlay", COLORMAPS, state.currentOverlayCmap, callbacks.onOverlayColormapChange);
  container.appendChild(cmap.item);

  // ── Filename on right ──
  const fnEl = document.createElement("span");
  fnEl.className = "filename";
  fnEl.textContent = filename;
  fnEl.title = filename;
  container.appendChild(fnEl);
}
