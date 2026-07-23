// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
/**
 * MarketingBanners — lizard.build branded billboards mounted flush on
 * real walls throughout the Dust_2 map.
 *
 * Positions were derived by scanning world.bin for solid columns with open
 * air on one face in the gameplay height range (Y 5–16).  Each banner is
 * offset 0.05 units from the wall face so there is no z-fighting.
 *
 * Canvas is 1024×512 (matching the 4×2 block plane) so text never clips.
 * MeshBasicMaterial keeps banners fully lit regardless of time-of-day.
 */

import * as THREE from "three";

// ── canvas texture ─────────────────────────────────────────────────────────

const W = 1024;
const H = 512;

function makeBannerTexture(logoUrl: string): Promise<THREE.CanvasTexture> {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;

    const img = new Image();
    img.onload = () => {
      // ── Apple-style: pure black, generous whitespace, clean hierarchy ─────
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, W, H);

      // Very subtle 1-px dark border — just enough to separate from the wall
      ctx.strokeStyle = "#2a2a2a";
      ctx.lineWidth   = 2;
      ctx.strokeRect(1, 1, W - 2, H - 2);

      // ── Logo ─────────────────────────────────────────────────────────────
      // The source image is a lizard on dark navy — we want it on pure black.
      // Draw it slightly larger so the lizard is prominent.
      const logoSize = 260;
      const logoX    = 56;
      const logoY    = (H - logoSize) / 2;
      ctx.drawImage(img, logoX, logoY, logoSize, logoSize);

      // Hairline separator — same grey Apple uses for dividers
      ctx.strokeStyle = "#2c2c2e";
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(logoX + logoSize + 44, H * 0.14);
      ctx.lineTo(logoX + logoSize + 44, H * 0.86);
      ctx.stroke();

      // ── Wordmark ─────────────────────────────────────────────────────────
      const SF = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif";
      const textX = logoX + logoSize + 80;

      // Primary: "lizard.build" — white, heavy weight, Apple headline scale
      ctx.fillStyle    = "#ffffff";
      ctx.font         = `700 88px ${SF}`;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign    = "left";
      ctx.fillText("lizard.build", textX, H / 2 + 22);

      // Secondary: tag line — Apple uses #86868b (secondary label grey)
      ctx.fillStyle = "#86868b";
      ctx.font      = `300 36px ${SF}`;
      ctx.fillText("cloud built for agents", textX, H / 2 + 72);

      resolve(new THREE.CanvasTexture(canvas));
    };
    img.src = logoUrl;
  });
}

// ── banner placements ──────────────────────────────────────────────────────
//
// Positions came from a terrain scan (world.bin.gz) — each entry sits exactly
// one voxel in front of a solid wall face.  rotY convention:
//   0          → normal +Z  (players at Z+ look toward -Z and see it)
//   Math.PI    → normal -Z
//  -Math.PI/2  → normal +X
//   Math.PI/2  → normal -X
//
// Areas covered: T spawn, mid-T corridor, mid, Long/A, B-tunnels, CT side.

interface BannerDef {
  pos:  [number, number, number];
  rotY: number;
}

const BANNERS: BannerDef[] = [
  // T-spawn back wall — faces players heading into the map
  { pos: [-30, 10, 16.05], rotY: 0 },
  // T-spawn side corridor
  { pos: [-20, 9, 20.95], rotY: Math.PI },
  // Mid-T approach
  { pos: [-10, 9, 40.95], rotY: Math.PI },
  // Mid centre (tall wall, north face)
  { pos: [0, 12, 62.95],  rotY: Math.PI },
  // Long / A-long inner wall
  { pos: [11, 12, 29.95], rotY: Math.PI },
  // A-site far wall
  { pos: [30, 12, 5.05],  rotY: 0 },
  // B-tunnels / B-site
  { pos: [20, 9, 81.95],  rotY: Math.PI },
  // CT corridor
  { pos: [50, 8, 70.95],  rotY: Math.PI },
];

// ── public API ─────────────────────────────────────────────────────────────

export async function loadMarketingBanners(scene: THREE.Scene): Promise<void> {
  const texture = await makeBannerTexture("/lizard_logo.png");
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;

  const mat = new THREE.MeshBasicMaterial({
    map:         texture,
    side:        THREE.FrontSide, // back is physical wall — no mirrored text
    transparent: false,
    depthWrite:  true,
  });

  const geo = new THREE.PlaneGeometry(4, 2); // 4 blocks wide × 2 blocks tall

  for (const { pos, rotY } of BANNERS) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...pos);
    mesh.rotation.y  = rotY;
    mesh.renderOrder = 1;
    scene.add(mesh);
  }

  console.log(`[MarketingBanners] ${BANNERS.length} banners placed`);
}
