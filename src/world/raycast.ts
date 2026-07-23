// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
// Ported from escape-tsuami-client/src/game/utils/raycast.ts's voxel DDA core,
// decoupled from the `game` singleton: takes an `isSolid(x,y,z)` callback
// (backed by World.isSolid) instead of reaching into a global chunk store.

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RaycastHit {
  position: Vec3;
  normal: Vec3;
}

export function raycastWithNormal(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  isSolid: (x: number, y: number, z: number) => boolean,
): RaycastHit | null {
  const stepX = direction.x > 0 ? 1 : -1;
  const stepY = direction.y > 0 ? 1 : -1;
  const stepZ = direction.z > 0 ? 1 : -1;

  const tDeltaX = Math.abs(1 / direction.x);
  const tDeltaY = Math.abs(1 / direction.y);
  const tDeltaZ = Math.abs(1 / direction.z);

  let voxelX = Math.floor(origin.x);
  let voxelY = Math.floor(origin.y);
  let voxelZ = Math.floor(origin.z);

  let tMaxX = (voxelX + (stepX > 0 ? 1 : 0) - origin.x) / direction.x;
  let tMaxY = (voxelY + (stepY > 0 ? 1 : 0) - origin.y) / direction.y;
  let tMaxZ = (voxelZ + (stepZ > 0 ? 1 : 0) - origin.z) / direction.z;

  let lastAxis = -1; // 0=x, 1=y, 2=z

  for (let i = 0; i < maxDistance; i++) {
    if (isSolid(voxelX, voxelY, voxelZ)) {
      const normal: Vec3 = { x: 0, y: 0, z: 0 };
      if (lastAxis === 0) normal.x = -stepX;
      else if (lastAxis === 1) normal.y = -stepY;
      else if (lastAxis === 2) normal.z = -stepZ;

      return { position: { x: voxelX, y: voxelY, z: voxelZ }, normal };
    }

    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      lastAxis = 0;
      voxelX += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxZ) {
      lastAxis = 1;
      voxelY += stepY;
      tMaxY += tDeltaY;
    } else {
      lastAxis = 2;
      voxelZ += stepZ;
      tMaxZ += tDeltaZ;
    }
  }

  return null;
}
