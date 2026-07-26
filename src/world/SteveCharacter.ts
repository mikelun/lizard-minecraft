// © 2026 lizard.build — All rights reserved.
// Renders a Minecraft Steve character from the canonical steve.geo.json model
// (64×64 skin, matches vanilla ModelBiped proportions exactly, including the
// jacket/hat/sleeve/pants overlay layer), with optional armor and a rifle held
// with the Point Blank player_rifle animation.

import * as THREE from "three";
import { buildGeoModel, GeckoAnimator } from "./GeckoLibGun";

const DEG = THREE.MathUtils.degToRad;

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

const ARMOR_SLOT_TO_BONE: Record<string, string> = {
  bipedHead:     "head",
  bipedBody:     "body",
  bipedLeftArm:  "leftArm",
  bipedRightArm: "rightArm",
  bipedLeftLeg:  "leftLeg",
  bipedRightLeg: "rightLeg",
};

// Point Blank player_rifle animation bone names → Steve bone names
const PB_TO_STEVE: Record<string, string> = {
  torso:     "body",
  right_arm: "rightArm",
  left_arm:  "leftArm",
  right_leg: "rightLeg",
  left_leg:  "leftLeg",
  head:      "head",
};

export interface GunDef {
  geo: string;
  tex: string;
  scale?: number;
}

export class SteveCharacter {
  readonly root: THREE.Group;
  readonly bones: Record<string, THREE.Group> = {};

  /** When true, plays the Point Blank rifle walking animation instead of idle swing. */
  aiming = false;

  private walkTime   = 0;
  private loaded     = false;
  private animator: GeckoAnimator | null = null;

  // Weapon cycling
  private gunRoots:    THREE.Group[] = [];
  private activeGun    = 0;
  private swapTimer    = 0;
  private swapInterval = 0; // 0 = disabled

  constructor() {
    this.root      = new THREE.Group();
    this.root.name = "SteveCharacter";
    this._load();
  }

  private async _load(): Promise<void> {
    const [geoData, tex, animData] = await Promise.all([
      fetchJSON("/marbled/steve.geo.json"),
      loadTex("/textures/steve.png"),
      fetchJSON("/pointblank/animations/player_rifle.animation.json"),
    ]);

    const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.05 });
    const { root: modelRoot, boneGroups } = buildGeoModel(geoData, tex, 1 / 16);
    modelRoot.traverse(obj => { if (obj instanceof THREE.Mesh) obj.material = mat; });
    this.root.add(modelRoot);

    this.bones.root     = boneGroups["root"];
    this.bones.waist    = boneGroups["waist"];
    this.bones.body     = boneGroups["body"];
    this.bones.head     = boneGroups["head"];
    this.bones.rightArm = boneGroups["rightArm"];
    this.bones.leftArm  = boneGroups["leftArm"];
    this.bones.rightLeg = boneGroups["rightLeg"];
    this.bones.leftLeg  = boneGroups["leftLeg"];

    // Only rotations from PB animation apply; positions are from Steve's own rig.
    for (const grp of Object.values(this.bones)) {
      if (grp) grp.userData.ignoreGeckoPosition = true;
    }

    const pbBones: Record<string, THREE.Group> = {};
    for (const [pbName, steveName] of Object.entries(PB_TO_STEVE)) {
      if (this.bones[steveName]) pbBones[pbName] = this.bones[steveName];
    }

    this.animator = new GeckoAnimator(animData, pbBones);
    this.animator.play("walking", true);

    this.loaded = true;
  }

  async equipArmor(geoUrl: string, texUrl: string): Promise<void> {
    while (!this.loaded) await new Promise(r => setTimeout(r, 16));
    const [geoData, tex] = await Promise.all([fetchJSON(geoUrl), loadTex(texUrl)]);
    const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.05 });
    const { boneGroups } = buildGeoModel(geoData, tex, 1 / 16);
    for (const [armorBone, steveBone] of Object.entries(ARMOR_SLOT_TO_BONE)) {
      const ag = boneGroups[armorBone];
      const sb = this.bones[steveBone];
      if (!ag || !sb) continue;
      ag.traverse(obj => { if (obj instanceof THREE.Mesh) obj.material = mat; });
      ag.position.set(0, 0, 0);
      sb.add(ag);
    }
  }

  equipSwatArmor(): Promise<void> {
    return this.equipArmor("/marbled/swat_armor.geo.json", "/marbled/swat_armor.png");
  }

  private async _loadGun(geoUrl: string, texUrl: string, scale: number): Promise<THREE.Group> {
    while (!this.loaded) await new Promise(r => setTimeout(r, 16));
    const [geoData, tex] = await Promise.all([fetchJSON(geoUrl), loadTex(texUrl)]);
    const { root: gunRoot, boneGroups: gunBones } = buildGeoModel(geoData, tex, 1 / 16);

    for (const name of [
      "rightarm", "leftarm", "muzzleflash", "bullet", "scope",
      "_cb_suppressor", "_cb_scope", "_cb_canted", "_cb_grip", "_camera_",
      "bullet_in_mag", "bullet_in_barrel",
      "mag_extended_1", "mag_extended_2", "mag_extended_3",
    ]) {
      if (gunBones[name]) gunBones[name].visible = false;
    }
    for (const boneName of ["righthand_pos", "lefthand_pos", "righthand", "lefthand"]) {
      const grp = gunBones[boneName];
      if (!grp) continue;
      for (const child of [...grp.children]) {
        if (child instanceof THREE.Mesh) grp.remove(child);
      }
    }

    gunRoot.scale.setScalar(scale);
    gunRoot.rotation.set(DEG(-90), DEG(0), DEG(0));

    const anchor = gunBones["rightarm"] ?? gunBones["thirdperson_hand"];
    if (anchor) {
      gunRoot.updateMatrixWorld(true);
      const ap = new THREE.Vector3();
      anchor.getWorldPosition(ap);
      gunRoot.position.set(-ap.x, -0.625 - ap.y, -ap.z);
    } else {
      gunRoot.position.set(0.0, -0.625, 0.05);
    }

    return gunRoot;
  }

  /** Remove all equipped guns (call before equipping a new weapon tier). */
  clearGuns(): void {
    for (const g of this.gunRoots) {
      if (this.bones.rightArm) this.bones.rightArm.remove(g);
    }
    this.gunRoots  = [];
    this.activeGun = 0;
    this.swapTimer = 0;
    this.swapInterval = 0;
  }

  /** Add a single gun to the arm (no cycling). */
  async equipGun(geoUrl: string, texUrl: string, scale = 0.45): Promise<void> {
    const gunRoot = await this._loadGun(geoUrl, texUrl, scale);
    gunRoot.visible = true;
    this.gunRoots.push(gunRoot);
    this.bones.rightArm.add(gunRoot);
  }

  /**
   * Load a pool of guns and cycle through them every `intervalS` seconds.
   * Each definition can override the default scale.
   */
  async startWeaponCycle(guns: GunDef[], intervalS = 5): Promise<void> {
    this.swapInterval = intervalS;
    this.swapTimer    = intervalS; // first swap after full interval

    const roots = await Promise.all(
      guns.map(g => this._loadGun(g.geo, g.tex, g.scale ?? 0.45))
    );

    // Remove any previously equipped single gun
    for (const old of this.gunRoots) this.bones.rightArm.remove(old);
    this.gunRoots = roots;
    this.activeGun = 0;

    for (let i = 0; i < roots.length; i++) {
      roots[i].visible = i === 0;
      this.bones.rightArm.add(roots[i]);
    }
  }

  update(dt: number, walking: boolean, yaw = 0): void {
    this.root.rotation.y = yaw;
    if (!this.loaded) return;

    this.walkTime += dt;

    // Weapon cycling
    if (this.swapInterval > 0 && this.gunRoots.length > 1) {
      this.swapTimer -= dt;
      if (this.swapTimer <= 0) {
        this.swapTimer += this.swapInterval;
        this.gunRoots[this.activeGun].visible = false;
        this.activeGun = (this.activeGun + 1) % this.gunRoots.length;
        this.gunRoots[this.activeGun].visible = true;
      }
    }

    if (this.aiming && this.animator) {
      this.animator.update(dt);
    } else {
      const t         = this.walkTime;
      const walkSpeed = 1.8;
      const phase     = t * walkSpeed * Math.PI * 2;
      const walkAmp   = walking ? Math.PI / 6 : 0;
      const armAmp    = walkAmp * 0.7;

      const { rightLeg, leftLeg, rightArm, leftArm, head } = this.bones;
      if (rightLeg) rightLeg.rotation.x =  Math.sin(phase) * walkAmp;
      if (leftLeg)  leftLeg.rotation.x  = -Math.sin(phase) * walkAmp;
      if (rightArm) { rightArm.rotation.x = -Math.sin(phase) * armAmp; rightArm.rotation.z = 0; }
      if (leftArm)  { leftArm.rotation.x  =  Math.sin(phase) * armAmp; leftArm.rotation.z  = 0; }
      if (head) {
        head.rotation.y = Math.sin(t * 0.4) * 0.08;
        head.rotation.x = Math.sin(t * 0.25) * 0.03;
      }
    }
  }
}
