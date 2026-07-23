// © 2026 lizard.build — All rights reserved.
// Renders a Minecraft Steve character from the canonical steve.geo.json model
// (64×64 skin, matches vanilla ModelBiped proportions exactly, including the
// jacket/hat/sleeve/pants overlay layer), with optional SWAT armor equip.

import * as THREE from "three";
import { buildGeoModel } from "./GeckoLibGun";

function loadTex(url: string): Promise<THREE.Texture> {
  return new Promise(resolve => {
    new THREE.TextureLoader().load(url, tex => {
      tex.magFilter  = THREE.NearestFilter;
      tex.minFilter  = THREE.NearestFilter;
      tex.colorSpace = THREE.NoColorSpace;
      resolve(tex);
    });
  });
}

async function fetchJSON(url: string): Promise<any> {
  return fetch(url).then(r => r.json());
}

// Maps swat_armor.geo.json's top-level "biped*" container bones (each holding
// the actual "armor*" cubes as a child, already positioned relative to that
// shared pivot) onto SteveCharacter's own bone names.
const ARMOR_SLOT_TO_BONE: Record<string, string> = {
  bipedHead:     "head",
  bipedBody:     "body",
  bipedLeftArm:  "leftArm",
  bipedRightArm: "rightArm",
  bipedLeftLeg:  "leftLeg",
  bipedRightLeg: "rightLeg",
};

export class SteveCharacter {
  /** Root group — position this to place the character in world space. */
  readonly root: THREE.Group;

  readonly bones: Record<string, THREE.Group> = {};
  private walkTime = 0;
  private loaded    = false;

  constructor() {
    this.root      = new THREE.Group();
    this.root.name = "SteveCharacter";
    this._load();
  }

  private async _load(): Promise<void> {
    const [geoData, tex] = await Promise.all([
      fetchJSON("/marbled/steve.geo.json"),
      loadTex("/textures/steve.png"),
    ]);

    const mat = new THREE.MeshLambertMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.05,
    });
    // Re-apply the shared skin material to every cube buildGeoModel created
    // (it builds one material per cube by default).
    const { root: modelRoot, boneGroups } = buildGeoModel(geoData, tex, 1 / 16);
    modelRoot.traverse(obj => {
      if (obj instanceof THREE.Mesh) obj.material = mat;
    });

    this.root.add(modelRoot);

    this.bones.root     = boneGroups["root"];
    this.bones.waist    = boneGroups["waist"];
    this.bones.body     = boneGroups["body"];
    this.bones.head     = boneGroups["head"];
    this.bones.rightArm = boneGroups["rightArm"];
    this.bones.leftArm  = boneGroups["leftArm"];
    this.bones.rightLeg = boneGroups["rightLeg"];
    this.bones.leftLeg  = boneGroups["leftLeg"];

    this.loaded = true;
    console.log("[SteveCharacter] loaded.");
  }

  /**
   * Equip SWAT body armor (public/marbled/swat_armor.geo.json + .png) onto
   * this character. The file's "biped*" bones are positioning containers that
   * share the exact same pivots as our own body/head/arm/leg bones, so each
   * one's position is re-zeroed and it's re-parented directly onto the
   * matching bone — the armor then inherits that bone's animation for free.
   */
  async equipSwatArmor(): Promise<void> {
    while (!this.loaded) await new Promise(r => setTimeout(r, 16));

    const [geoData, tex] = await Promise.all([
      fetchJSON("/marbled/swat_armor.geo.json"),
      loadTex("/marbled/swat_armor.png"),
    ]);

    const mat = new THREE.MeshLambertMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.05,
    });
    const { boneGroups } = buildGeoModel(geoData, tex, 1 / 16);
    for (const [armorBoneName, steveBoneName] of Object.entries(ARMOR_SLOT_TO_BONE)) {
      const armorGroup = boneGroups[armorBoneName];
      const steveBone  = this.bones[steveBoneName];
      if (!armorGroup || !steveBone) continue;
      armorGroup.traverse(obj => {
        if (obj instanceof THREE.Mesh) obj.material = mat;
      });
      armorGroup.position.set(0, 0, 0);
      steveBone.add(armorGroup);
    }
  }

  /**
   * Call every frame.
   * @param dt       Delta time in seconds
   * @param walking  Whether the character is walking (drives leg/arm swing)
   * @param yaw      Character facing direction in radians (world Y rotation)
   */
  update(dt: number, walking: boolean, yaw = 0): void {
    this.root.rotation.y = yaw;

    if (!this.loaded) return;

    this.walkTime += dt;
    const t         = this.walkTime;
    const walkSpeed = 1.8;
    const walkAmp   = walking ? Math.PI / 6 : 0;
    const phase     = t * walkSpeed * Math.PI * 2;

    const { rightLeg, leftLeg, rightArm, leftArm, head } = this.bones;

    if (rightLeg) rightLeg.rotation.x =  Math.sin(phase) * walkAmp;
    if (leftLeg)  leftLeg.rotation.x  = -Math.sin(phase) * walkAmp;

    const armAmp = walkAmp * 0.7;
    if (rightArm) rightArm.rotation.x = -Math.sin(phase) * armAmp;
    if (leftArm)  leftArm.rotation.x  =  Math.sin(phase) * armAmp;

    if (head) {
      head.rotation.y = Math.sin(t * 0.4) * 0.08;
      head.rotation.x = Math.sin(t * 0.25) * 0.03;
    }
  }
}
