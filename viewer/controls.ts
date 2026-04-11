// ════════════════════════════════════════════════════════════════════════
//  DOM control builders
// ════════════════════════════════════════════════════════════════════════

import type { SliderControl, RangeSliderControl, DropdownControl, CheckboxControl } from "./types";

function _makeEditable(valSpan: HTMLSpanElement, rangeInput: HTMLInputElement): void {
    valSpan.style.cursor = "text";
    valSpan.title = "Click to edit";
    valSpan.addEventListener("click", () => {
        const current = valSpan.textContent || "";
        const inp = document.createElement("input");
        inp.type = "text";
        inp.value = current;
        inp.className = "nv-editable-value";
        inp.style.width = Math.max(36, current.length * 9) + "px";
        inp.style.fontSize = "13px";
        inp.style.background = "#333";
        inp.style.color = "#fff";
        inp.style.border = "1px solid #5b9bd5";
        inp.style.borderRadius = "2px";
        inp.style.padding = "0 3px";
        inp.style.textAlign = "center";
        inp.style.fontVariantNumeric = "tabular-nums";

        const apply = () => {
            const num = parseInt(inp.value);
            if (!isNaN(num)) {
                const clamped = Math.max(parseInt(rangeInput.min), Math.min(parseInt(rangeInput.max), num));
                rangeInput.value = String(clamped);
                valSpan.textContent = String(clamped);
                rangeInput.dispatchEvent(new Event("input", { bubbles: true }));
                rangeInput.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
                valSpan.textContent = rangeInput.value;
            }
            inp.replaceWith(valSpan);
        };

        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); apply(); }
            if (e.key === "Escape") { valSpan.textContent = rangeInput.value; inp.replaceWith(valSpan); }
        });
        inp.addEventListener("blur", apply);
        valSpan.replaceWith(inp);
        inp.focus();
        inp.select();
    });
}

export function createElement(tag: string, className?: string): HTMLElement {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
}

export function createSlider(label: string, min: number, max: number, value: number): SliderControl {
    const container = createElement("div", "nv-slider");
    const lbl = createElement("label", "nv-slider-label");
    lbl.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.className = "nv-slider-input";
    const valSpan = createElement("span", "nv-slider-value") as HTMLSpanElement;
    valSpan.textContent = String(value);
    input.addEventListener("input", () => { valSpan.textContent = input.value; });
    _makeEditable(valSpan, input);
    container.append(lbl, input, valSpan);
    return { container, input, valSpan };
}

export function createDropdown(label: string, options: [string, string][], value: string): DropdownControl {
    const container = createElement("div", "nv-dropdown");
    const lbl = createElement("label", "nv-dropdown-label");
    lbl.textContent = label;
    const select = document.createElement("select");
    select.className = "nv-select";
    for (const [text, val] of options) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = text;
        if (val === value) opt.selected = true;
        select.appendChild(opt);
    }
    container.append(lbl, select);
    return { container, select };
}

export function createCheckbox(label: string, checked: boolean): CheckboxControl {
    const container = createElement("label", "nv-checkbox");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    const span = createElement("span", "");
    span.textContent = label;
    container.append(input, span);
    return { container, input };
}

export function createRangeSlider(
    label: string, min: number, max: number, valueLo: number, valueHi: number
): RangeSliderControl {
    const container = createElement("div", "nv-range-slider");
    const lbl = createElement("label", "nv-slider-label");
    lbl.textContent = label;

    const valLoSpan = createElement("span", "nv-range-val") as HTMLSpanElement;
    valLoSpan.textContent = String(valueLo);

    const track = createElement("div", "nv-range-track");

    const inputLo = document.createElement("input");
    inputLo.type = "range";
    inputLo.min = String(min);
    inputLo.max = String(max);
    inputLo.value = String(valueLo);
    inputLo.className = "nv-range-input nv-range-lo";

    const inputHi = document.createElement("input");
    inputHi.type = "range";
    inputHi.min = String(min);
    inputHi.max = String(max);
    inputHi.value = String(valueHi);
    inputHi.className = "nv-range-input nv-range-hi";

    const fill = createElement("div", "nv-range-fill");
    track.append(inputLo, inputHi, fill);

    const valHiSpan = createElement("span", "nv-range-val") as HTMLSpanElement;
    valHiSpan.textContent = String(valueHi);

    const updateFill = () => {
        const lo = parseInt(inputLo.value);
        const hi = parseInt(inputHi.value);
        const range = max - min || 1;
        const leftPct = ((lo - min) / range) * 100;
        const rightPct = ((hi - min) / range) * 100;
        fill.style.left = leftPct + "%";
        fill.style.width = (rightPct - leftPct) + "%";
    };

    // Prevent thumbs from crossing
    inputLo.addEventListener("input", () => {
        if (parseInt(inputLo.value) > parseInt(inputHi.value)) {
            inputLo.value = inputHi.value;
        }
        valLoSpan.textContent = inputLo.value;
        updateFill();
    });
    inputHi.addEventListener("input", () => {
        if (parseInt(inputHi.value) < parseInt(inputLo.value)) {
            inputHi.value = inputLo.value;
        }
        valHiSpan.textContent = inputHi.value;
        updateFill();
    });

    // Make whichever thumb is closer to the pointer draggable on top.
    // Without this, the lo input (higher z-index) blocks dragging hi.
    track.addEventListener("pointerdown", (e: PointerEvent) => {
        const rect = track.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        const valAtClick = min + pct * (max - min);
        const lo = parseInt(inputLo.value);
        const hi = parseInt(inputHi.value);
        if (Math.abs(valAtClick - hi) < Math.abs(valAtClick - lo)) {
            inputHi.style.zIndex = "4";
            inputLo.style.zIndex = "3";
        } else {
            inputLo.style.zIndex = "4";
            inputHi.style.zIndex = "3";
        }
    });

    _makeEditable(valLoSpan, inputLo);
    _makeEditable(valHiSpan, inputHi);

    container.append(lbl, valLoSpan, track, valHiSpan);
    updateFill();

    // Expose updateFill so external code can refresh after programmatic changes
    (container as any)._updateFill = updateFill;

    return { container, inputLo, inputHi, valLoSpan, valHiSpan };
}

export function createButton(label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "nv-btn";
    btn.textContent = label;
    return btn;
}
