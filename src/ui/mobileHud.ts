// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
/**
 * Mobile HUD overlay: virtual joystick (left) + fire/jump/reload buttons (right).
 * Call setupMobileControls() only when controller.isMobile is true.
 * The joystick radius (JRAD) must match the JRAD constant in Controller.ts.
 */
import type { PlayerController } from "../player/Controller";

const JRAD = 70;    // joystick outer radius (px) — keep in sync with Controller.ts
const KNOB_R = 26;  // joystick knob radius (px)

function circle(
  right: string | null,
  left: string | null,
  bottom: string,
  size: number,
  bg: string,
  border: string,
  label: string,
  fontSize = 13,
): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.cssText = [
    "position:absolute",
    right  != null ? `right:${right}`   : "",
    left   != null ? `left:${left}`     : "",
    `bottom:${bottom}`,
    `width:${size}px`,
    `height:${size}px`,
    "border-radius:50%",
    `background:${bg}`,
    `border:2px solid ${border}`,
    "pointer-events:auto",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "font-family:monospace",
    "color:#fff",
    `font-size:${fontSize}px`,
    "font-weight:bold",
    "text-shadow:0 0 4px #000",
    "user-select:none",
    "-webkit-user-select:none",
    "-webkit-tap-highlight-color:transparent",
    "touch-action:none",
  ].filter(Boolean).join(";");
  return el;
}

export interface MobileControls {
  /** Call each frame so the knob follows the joystick delta (-1..+1). */
  updateKnob(kx: number, kz: number): void;
}

export function setupMobileControls(
  container: HTMLElement,
  controller: PlayerController,
): MobileControls {
  // Prevent browser pan/zoom on the game canvas
  document.body.style.touchAction = "none";
  document.body.style.overflow = "hidden";

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:20;";
  container.appendChild(overlay);

  // ── Joystick base ──────────────────────────────────────────────────────────
  const jBase = document.createElement("div");
  jBase.style.cssText = [
    "position:absolute",
    `left:24px`,
    `bottom:24px`,
    `width:${JRAD * 2}px`,
    `height:${JRAD * 2}px`,
    "border-radius:50%",
    "background:rgba(255,255,255,0.07)",
    "border:2px solid rgba(255,255,255,0.30)",
    "touch-action:none",
  ].join(";");
  overlay.appendChild(jBase);

  // ── Joystick knob ──────────────────────────────────────────────────────────
  const jKnob = document.createElement("div");
  jKnob.style.cssText = [
    "position:absolute",
    `width:${KNOB_R * 2}px`,
    `height:${KNOB_R * 2}px`,
    "border-radius:50%",
    "background:rgba(255,255,255,0.45)",
    "border:2px solid rgba(255,255,255,0.75)",
    "transform:translate(-50%,-50%)",
    "top:50%",
    "left:50%",
    "pointer-events:none",
    "transition:left 0.05s,top 0.05s",
  ].join(";");
  jBase.appendChild(jKnob);

  function updateKnob(kx: number, kz: number) {
    jKnob.style.left = `${50 + kx * 50}%`;
    jKnob.style.top  = `${50 + kz * 50}%`;
  }

  // ── Fire button (bottom-right) ─────────────────────────────────────────────
  const FIRE_R = 46;
  const fireBtn = circle(
    "24px", null, "24px",
    FIRE_R * 2,
    "rgba(255,70,70,0.50)",
    "rgba(255,120,120,0.80)",
    "FIRE", 14,
  );
  overlay.appendChild(fireBtn);

  fireBtn.addEventListener("touchstart", (e) => {
    e.stopPropagation(); e.preventDefault();
    fireBtn.style.background = "rgba(255,70,70,0.85)";
    controller.startFiring();
  }, { passive: false });
  fireBtn.addEventListener("touchend", (e) => {
    e.stopPropagation(); e.preventDefault();
    fireBtn.style.background = "rgba(255,70,70,0.50)";
    controller.stopFiring();
  }, { passive: false });
  fireBtn.addEventListener("touchcancel", () => {
    fireBtn.style.background = "rgba(255,70,70,0.50)";
    controller.stopFiring();
  });

  // ── Jump button (above fire) ───────────────────────────────────────────────
  const JUMP_R = 34;
  const jumpBtn = circle(
    `${24 + FIRE_R - JUMP_R}px`, null,
    `${24 + FIRE_R * 2 + 12}px`,
    JUMP_R * 2,
    "rgba(80,160,255,0.50)",
    "rgba(120,190,255,0.80)",
    "JUMP", 12,
  );
  overlay.appendChild(jumpBtn);

  jumpBtn.addEventListener("touchstart", (e) => {
    e.stopPropagation(); e.preventDefault();
    jumpBtn.style.background = "rgba(80,160,255,0.85)";
    controller.doJump();
  }, { passive: false });
  jumpBtn.addEventListener("touchend", (e) => {
    e.stopPropagation(); e.preventDefault();
    jumpBtn.style.background = "rgba(80,160,255,0.50)";
  }, { passive: false });

  // ── Reload button (left of fire) ───────────────────────────────────────────
  const RELOAD_R = 28;
  const reloadBtn = circle(
    `${24 + FIRE_R * 2 + 12}px`, null,
    `${24 + FIRE_R - RELOAD_R}px`,
    RELOAD_R * 2,
    "rgba(255,200,60,0.50)",
    "rgba(255,220,110,0.80)",
    "R", 16,
  );
  overlay.appendChild(reloadBtn);

  reloadBtn.addEventListener("touchstart", (e) => {
    e.stopPropagation(); e.preventDefault();
    reloadBtn.style.background = "rgba(255,200,60,0.85)";
    controller.ak47.reload();
  }, { passive: false });
  reloadBtn.addEventListener("touchend", (e) => {
    e.stopPropagation(); e.preventDefault();
    reloadBtn.style.background = "rgba(255,200,60,0.50)";
  }, { passive: false });

  // ── Crouch toggle (above joystick) ─────────────────────────────────────────
  const CROUCH_R = 28;
  const crouchBtn = circle(
    null, `${24 + JRAD - CROUCH_R}px`,
    `${24 + JRAD * 2 + 12}px`,
    CROUCH_R * 2,
    "rgba(160,255,160,0.50)",
    "rgba(180,255,180,0.80)",
    "CTR", 11,
  );
  overlay.appendChild(crouchBtn);

  let crouching = false;
  crouchBtn.addEventListener("touchstart", (e) => {
    e.stopPropagation(); e.preventDefault();
    crouching = !crouching;
    controller.physics.crouching = crouching;
    crouchBtn.style.background = crouching
      ? "rgba(80,200,80,0.85)"
      : "rgba(160,255,160,0.50)";
  }, { passive: false });

  return { updateKnob };
}
