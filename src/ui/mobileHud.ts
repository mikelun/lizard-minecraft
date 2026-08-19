// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
/**
 * Mobile HUD overlay: virtual joystick (left) + fire/jump/reload buttons (right).
 * Call setupMobileControls() only when controller.isMobile is true.
 * The joystick radius (JRAD) must match the JRAD constant in Controller.ts.
 */
import type { PlayerController } from "../player/Controller";

const JRAD = 70;    // joystick outer radius (px) — keep in sync with Controller.ts
const KNOB_R = 26;  // joystick knob radius (px)

// Glassmorphism buttons — translucent blurred glass with a colored accent ring
// per role, an inset highlight for depth, and a pressed state that brightens
// the glow and scales down slightly for tactile feedback.
function circle(
  right: string | null,
  left: string | null,
  bottom: string,
  size: number,
  accent: string, // "r,g,b" — drives border/glow/press-state color
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
    `background:radial-gradient(circle at 32% 28%, rgba(255,255,255,0.16), rgba(18,19,22,0.6) 72%)`,
    "backdrop-filter:blur(8px)",
    "-webkit-backdrop-filter:blur(8px)",
    `border:1.5px solid rgba(${accent},0.55)`,
    `box-shadow:0 4px 16px rgba(0,0,0,0.4),inset 0 1px 1px rgba(255,255,255,0.18),0 0 10px rgba(${accent},0.25)`,
    "pointer-events:auto",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "font-family:Arial,sans-serif",
    "color:#fff",
    `font-size:${fontSize}px`,
    "font-weight:800",
    "letter-spacing:0.5px",
    "text-transform:uppercase",
    "text-shadow:0 1px 3px rgba(0,0,0,0.8)",
    "user-select:none",
    "-webkit-user-select:none",
    "-webkit-tap-highlight-color:transparent",
    "touch-action:none",
    "transition:transform 0.08s ease-out,box-shadow 0.12s ease-out,background 0.12s ease-out",
  ].filter(Boolean).join(";");
  return el;
}

function pressBtn(el: HTMLDivElement, accent: string) {
  el.style.transform = "scale(0.90)";
  el.style.background = `radial-gradient(circle at 32% 28%, rgba(255,255,255,0.22), rgba(${accent},0.38) 72%)`;
  el.style.boxShadow = `0 2px 10px rgba(0,0,0,0.45),inset 0 1px 1px rgba(255,255,255,0.25),0 0 18px rgba(${accent},0.55)`;
}
function releaseBtn(el: HTMLDivElement, accent: string) {
  el.style.transform = "scale(1)";
  el.style.background = "radial-gradient(circle at 32% 28%, rgba(255,255,255,0.16), rgba(18,19,22,0.6) 72%)";
  el.style.boxShadow = `0 4px 16px rgba(0,0,0,0.4),inset 0 1px 1px rgba(255,255,255,0.18),0 0 10px rgba(${accent},0.25)`;
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
    "background:radial-gradient(circle at 35% 30%, rgba(255,255,255,0.10), rgba(18,19,22,0.35) 75%)",
    "backdrop-filter:blur(6px)",
    "-webkit-backdrop-filter:blur(6px)",
    "border:1.5px solid rgba(255,255,255,0.28)",
    "box-shadow:0 4px 16px rgba(0,0,0,0.35),inset 0 1px 1px rgba(255,255,255,0.12)",
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
    "background:radial-gradient(circle at 35% 30%, rgba(255,255,255,0.9), rgba(210,214,220,0.55) 75%)",
    "border:1.5px solid rgba(255,255,255,0.85)",
    "box-shadow:0 2px 8px rgba(0,0,0,0.35)",
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
  const FIRE_ACCENT = "255,80,80";
  const FIRE_R = 46;
  const fireBtn = circle("24px", null, "24px", FIRE_R * 2, FIRE_ACCENT, "FIRE", 14);
  overlay.appendChild(fireBtn);

  fireBtn.addEventListener("touchstart", (e) => {
    e.stopPropagation(); e.preventDefault();
    pressBtn(fireBtn, FIRE_ACCENT);
    controller.startFiring();
  }, { passive: false });
  fireBtn.addEventListener("touchend", (e) => {
    e.stopPropagation(); e.preventDefault();
    releaseBtn(fireBtn, FIRE_ACCENT);
    controller.stopFiring();
  }, { passive: false });
  fireBtn.addEventListener("touchcancel", () => {
    releaseBtn(fireBtn, FIRE_ACCENT);
    controller.stopFiring();
  });

  // ── Jump button (above fire) ───────────────────────────────────────────────
  const JUMP_ACCENT = "90,170,255";
  const JUMP_R = 34;
  const jumpBtn = circle(
    `${24 + FIRE_R - JUMP_R}px`, null,
    `${24 + FIRE_R * 2 + 12}px`,
    JUMP_R * 2, JUMP_ACCENT, "JUMP", 12,
  );
  overlay.appendChild(jumpBtn);

  jumpBtn.addEventListener("touchstart", (e) => {
    e.stopPropagation(); e.preventDefault();
    pressBtn(jumpBtn, JUMP_ACCENT);
    controller.doJump();
  }, { passive: false });
  jumpBtn.addEventListener("touchend", (e) => {
    e.stopPropagation(); e.preventDefault();
    releaseBtn(jumpBtn, JUMP_ACCENT);
  }, { passive: false });

  // ── Reload button (left of fire) ───────────────────────────────────────────
  const RELOAD_ACCENT = "255,205,70";
  const RELOAD_R = 28;
  const reloadBtn = circle(
    `${24 + FIRE_R * 2 + 12}px`, null,
    `${24 + FIRE_R - RELOAD_R}px`,
    RELOAD_R * 2, RELOAD_ACCENT, "R", 16,
  );
  overlay.appendChild(reloadBtn);

  reloadBtn.addEventListener("touchstart", (e) => {
    e.stopPropagation(); e.preventDefault();
    pressBtn(reloadBtn, RELOAD_ACCENT);
    controller.ak47.reload();
  }, { passive: false });
  reloadBtn.addEventListener("touchend", (e) => {
    e.stopPropagation(); e.preventDefault();
    releaseBtn(reloadBtn, RELOAD_ACCENT);
  }, { passive: false });

  return { updateKnob };
}
