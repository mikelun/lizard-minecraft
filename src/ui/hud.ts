// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// NEW: DOM HUD overlay (crosshair, hotbar, debug readout, pointer-lock prompt).
// Nothing here is ported -- the source repo's UI is React/Zustand-driven and
// doesn't separate out cleanly.

export interface Hud {
  setSelected(index: number): void;
  setDebugText(text: string): void;
  showPrompt(show: boolean): void;
  setAmmo(current: number, reserve: number, reloading: boolean): void;
  /** Update the dynamic crosshair gap (pixels from centre to arm start). */
  updateCrosshair(gap: number): void;
  /** Show/hide the AWP scope overlay. level 0 = off, 1 = first zoom, 2 = second zoom. */
  setScopeOverlay(level: number): void;
  /** Blur the scope reticle lines by `px` pixels (0 = sharp, ~3 = moving blur). */
  setScopeBlur(px: number): void;
}

export function createHud(container: HTMLElement): Hud {
  const root = document.createElement("div");
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;font-family:monospace;color:#fff;user-select:none;";
  container.appendChild(root);

  // ── CS:GO-style dynamic crosshair ────────────────────────────────────────────
  // 4 arms + center dot.  Gap from centre to arm start is updated each frame.
  const XH_LEN  = 8;   // arm length (px)
  const XH_W    = 2;   // arm thickness (px)
  const XH_COLOR = "#04ff00";
  const XH_OUTLINE = "0 0 0 1px rgba(0,0,0,0.85)";

  const xhRoot = document.createElement("div");
  xhRoot.style.cssText = "position:absolute;top:50%;left:50%;pointer-events:none;";
  root.appendChild(xhRoot);

  function arm(horiz: boolean): HTMLDivElement {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:absolute",
      `background:${XH_COLOR}`,
      `box-shadow:${XH_OUTLINE}`,
      horiz
        ? `width:${XH_LEN}px;height:${XH_W}px;top:${-XH_W / 2}px`
        : `width:${XH_W}px;height:${XH_LEN}px;left:${-XH_W / 2}px`,
    ].join(";");
    return el;
  }

  const xhTop    = arm(false); // vertical, above centre
  const xhBottom = arm(false); // vertical, below centre
  const xhLeft   = arm(true);  // horizontal, left of centre
  const xhRight  = arm(true);  // horizontal, right of centre

  const xhDot = document.createElement("div");
  xhDot.style.cssText = `position:absolute;width:2px;height:2px;background:${XH_COLOR};left:-1px;top:-1px;box-shadow:${XH_OUTLINE};`;

  xhRoot.append(xhTop, xhBottom, xhLeft, xhRight, xhDot);

  function updateCrosshair(gap: number) {
    const g = Math.round(gap);
    xhTop.style.bottom    = `${g}px`;
    xhBottom.style.top    = `${g}px`;
    xhLeft.style.right    = `${g}px`;
    xhRight.style.left    = `${g}px`;
  }
  updateCrosshair(3); // initial resting gap

  const debugText = document.createElement("div");
  debugText.style.cssText = "position:absolute;top:8px;left:8px;font-size:12px;line-height:1.4;text-shadow:0 0 3px #000;white-space:pre;";
  root.appendChild(debugText);

  // ── Ammo counter (CS:GO style: bottom-right) ──────────────────────────────
  const ammoEl = document.createElement("div");
  ammoEl.style.cssText = `
    position:absolute;bottom:60px;right:24px;
    font-family:monospace;color:#fff;text-align:right;
    text-shadow:0 1px 4px #000,0 0 8px #000;
    line-height:1.1;
  `;
  root.appendChild(ammoEl);

  function setAmmo(current: number, reserve: number, reloading: boolean) {
    if (current < 0) {
      ammoEl.innerHTML = ""; // melee / no ammo display
    } else if (reloading) {
      ammoEl.innerHTML = `<span style="font-size:28px;color:#ffcc44;">RELOADING</span>`;
    } else {
      const lowColor = current <= 5 ? "#ff4444" : "#fff";
      ammoEl.innerHTML =
        `<span style="font-size:40px;font-weight:bold;color:${lowColor};">${current}</span>` +
        `<span style="font-size:22px;color:rgba(255,255,255,0.55);"> / ${reserve}</span>`;
    }
  }
  setAmmo(30, 90, false);

  // Selected-block hotbar UI was removed (this is a gun game, not a builder) —
  // keep the API no-op rather than touching every per-frame caller.
  function setSelected(_index: number) {}

  // ── AWP scope overlay ─────────────────────────────────────────────────────
  // Two layers: static panels (black surround + vignette, never blurred) and
  // the reticle lines (blurred via CSS filter when the player is moving).
  const scopePanels  = document.createElement("canvas");
  const scopeReticle = document.createElement("canvas");
  const cvStyle = "position:absolute;inset:0;width:100%;height:100%;display:none;pointer-events:none;";
  scopePanels.style.cssText  = cvStyle;
  scopeReticle.style.cssText = cvStyle;
  root.appendChild(scopePanels);
  root.appendChild(scopeReticle);

  let scopeLevel = 0;

  function drawScopePanels() {
    const w = window.innerWidth, h = window.innerHeight;
    scopePanels.width = w; scopePanels.height = h;
    const ctx = scopePanels.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const r  = Math.min(w, h) * 0.42;

    // Black panels outside the circle
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
    ctx.fill("evenodd");

    // Vignette inside the circle
    const grad = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Circle border
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawScopeReticle() {
    const w = window.innerWidth, h = window.innerHeight;
    scopeReticle.width = w; scopeReticle.height = h;
    const ctx = scopeReticle.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const r  = Math.min(w, h) * 0.42;

    const lineColor = "rgba(0,0,0,0.85)";
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;

    const gap = 12;
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx - gap, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - gap); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + r); ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

  }

  function setScopeOverlay(level: number) {
    const wasOff = scopeLevel === 0;
    scopeLevel = level;
    if (level === 0) {
      scopePanels.style.display  = "none";
      scopeReticle.style.display = "none";
      xhRoot.style.display = "";
    } else {
      scopePanels.style.display  = "block";
      scopeReticle.style.display = "block";
      xhRoot.style.display = "none";
      // Redraw panels on level change or first show (reticle only on level change)
      if (wasOff || level !== scopeLevel) drawScopePanels();
      drawScopeReticle();
    }
  }

  function setScopeBlur(px: number) {
    scopeReticle.style.filter = px > 0.05 ? `blur(${px.toFixed(2)}px)` : "";
  }

  window.addEventListener("resize", () => {
    if (scopeLevel > 0) { drawScopePanels(); drawScopeReticle(); }
  });

  return {
    setSelected,
    setDebugText: (text: string) => { debugText.textContent = text; },
    showPrompt: (_show: boolean) => {},
    setAmmo,
    updateCrosshair,
    setScopeOverlay,
    setScopeBlur,
  };
}
