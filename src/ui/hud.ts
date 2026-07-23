// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// NEW: DOM HUD overlay (crosshair, hotbar, debug readout, pointer-lock prompt).
// Nothing here is ported -- the source repo's UI is React/Zustand-driven and
// doesn't separate out cleanly.

import { BType } from "../world/types";
import { HOTBAR } from "../player/Controller";

const BLOCK_COLORS: Record<BType, string> = {
  [BType.air]:          "transparent",
  [BType.grass]:        "#5f9e3d",
  [BType.dirt]:         "#755233",
  [BType.stone]:        "#7d7d82",
  [BType.sand]:         "#dfd091",
  [BType.snow]:         "#f0f5fa",
  [BType.log]:          "#5c3f28",
  [BType.leaf]:         "#2d6e2d",
  [BType.planks]:       "#b08a54",
  [BType.water]:        "#3a6ec4",
  [BType.coal_ore]:     "#4a4a4a",
  [BType.iron_ore]:     "#c9956a",
  [BType.gold_ore]:     "#fcee4b",
  [BType.diamond_ore]:  "#4fc3d4",
  [BType.emerald_ore]:  "#17dd62",
  [BType.lapis_ore]:    "#1a4eb5",
  [BType.redstone_ore]: "#c01e1e",
  [BType.cherry_log]:   "#7a4a5a",
  [BType.cherry_leaf]:  "#f07090",
  // World import block types
  [BType.smooth_sandstone]:     "#e0d89c",
  [BType.white_concrete]:       "#e8e8e8",
  [BType.smooth_red_sandstone]: "#b85c2a",
  [BType.smooth_stone]:         "#9a9a9a",
  [BType.light_gray_concrete]:  "#9d9d9d",
  [BType.yellow_terracotta]:    "#c8a24d",
  [BType.stone_bricks]:         "#6b6b6b",
  [BType.coal_block]:           "#1a1a1a",
  [BType.prismarine_bricks]:    "#62a99c",
  [BType.white_terracotta]:     "#cfc2b4",
  [BType.cyan_terracotta]:      "#576c6e",
  [BType.red_terracotta]:       "#8f3d2d",
  [BType.green_terracotta]:     "#4a5c2c",
  [BType.lime_terracotta]:      "#677534",
  [BType.cobblestone]:          "#808080",
  [BType.sandstone]:            "#d9c97a",
  [BType.bricks]:               "#8c3b2a",
  [BType.chest]:                "#a0722a",
  [BType.chain]:                "#808080",
  // Cross-post types
  [BType.iron_bars]:                 "#9a9a9a",
  [BType.glass_pane]:                "#c8e8ff",
  [BType.oak_fence]:                 "#b08a54",
  // Door types
  [BType.oak_door]:                  "#8c6a3a",
  [BType.oak_trapdoor]:              "#8c6a3a",
  [BType.trapdoor_base]:             "#8c6a3a",
  [BType.door_base]:                 "#8c6a3a",
  // Stair types (use parent material colors; only the base ID needs an entry
  // since hud only displays whole BType enum members, not the orientation variants)
  [BType.stone_brick_stairs]:          "#6b6b6b",
  [BType.smooth_sandstone_stairs]:     "#e0d89c",
  [BType.sandstone_stairs]:            "#d9c97a",
  [BType.smooth_red_sandstone_stairs]: "#b85c2a",
  [BType.oak_stairs]:                  "#b08a54",
  [BType.prismarine_brick_stairs]:     "#62a99c",
  [BType.cobblestone_stairs]:          "#808080",
  [BType.brick_stairs]:                "#8c3b2a",
  // Slab types
  [BType.cut_sandstone_slab]:        "#e0d89c",
  [BType.smooth_sandstone_slab]:     "#e0d89c",
  [BType.smooth_stone_slab]:         "#9a9a9a",
  [BType.smooth_red_sandstone_slab]: "#b85c2a",
  [BType.oak_slab]:                  "#b08a54",
  [BType.stone_brick_slab]:          "#6b6b6b",
  [BType.prismarine_brick_slab]:     "#62a99c",
  // Top-half slab types
  [BType.cut_sandstone_slab_top]:        "#e0d89c",
  [BType.smooth_sandstone_slab_top]:     "#e0d89c",
  [BType.smooth_stone_slab_top]:         "#9a9a9a",
  [BType.smooth_red_sandstone_slab_top]: "#b85c2a",
  [BType.oak_slab_top]:                  "#b08a54",
  [BType.stone_brick_slab_top]:          "#6b6b6b",
  [BType.prismarine_brick_slab_top]:     "#62a99c",
};

export interface Hud {
  setSelected(index: number): void;
  setDebugText(text: string): void;
  showPrompt(show: boolean): void;
  setAmmo(current: number, reserve: number, reloading: boolean): void;
  /** Update the dynamic crosshair gap (pixels from centre to arm start). */
  updateCrosshair(gap: number): void;
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

  const hotbar = document.createElement("div");
  hotbar.style.cssText = "position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:4px;";
  root.appendChild(hotbar);

  const slots: HTMLDivElement[] = HOTBAR.map((block, i) => {
    const slot = document.createElement("div");
    slot.style.cssText = `
      width:40px;height:40px;border:2px solid rgba(255,255,255,0.4);
      background:${BLOCK_COLORS[block]};display:flex;align-items:flex-end;
      justify-content:flex-end;font-size:10px;padding:2px;box-sizing:border-box;
      text-shadow:0 0 2px #000;
    `;
    slot.textContent = String(i + 1);
    hotbar.appendChild(slot);
    return slot;
  });

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
    if (reloading) {
      ammoEl.innerHTML = `<span style="font-size:28px;color:#ffcc44;">RELOADING</span>`;
    } else {
      const lowColor = current <= 5 ? "#ff4444" : "#fff";
      ammoEl.innerHTML =
        `<span style="font-size:40px;font-weight:bold;color:${lowColor};">${current}</span>` +
        `<span style="font-size:22px;color:rgba(255,255,255,0.55);"> / ${reserve}</span>`;
    }
  }
  setAmmo(30, 90, false);

  function setSelected(index: number) {
    slots.forEach((s, i) => {
      s.style.borderColor = i === index ? "#fff" : "rgba(255,255,255,0.4)";
      s.style.boxShadow = i === index ? "0 0 8px #fff" : "none";
    });
  }
  setSelected(0);

  return {
    setSelected,
    setDebugText: (text: string) => { debugText.textContent = text; },
    showPrompt: (_show: boolean) => {},
    setAmmo,
    updateCrosshair,
  };
}
