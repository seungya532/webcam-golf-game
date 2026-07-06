// scene3d.js
// Three.js(CDN ESM) 3D 골프 필드. 경사 지형(높이맵) · 나무 · 연못 · 산 ·
// 공 추적 카메라 · 홀인 드롭 애니메이션.
// 좌표계 : x = 좌우(yd), z = -전진(yd), y = 높이. 1 yard ≈ 1 unit.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

// 지형 높이 함수 : 티/그린 근처는 평평, 페어웨이 중간은 완만한 경사.
function terrainH(x, z, total) {
  const f = -z;
  let h = Math.sin(f * 0.016 + 0.4) * 3.2
        + Math.sin(f * 0.006 + 1.1) * 4.4
        + Math.cos(x * 0.02 + 0.6) * 2.6
        + Math.sin((x + f) * 0.012) * 1.8;
  const edge = smoothstep(0, 70, f) * smoothstep(0, 70, total - f);
  return h * edge;
}
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = makeSkyTexture();

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 6000);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x5a9e52, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff6d8, 0.7);
    sun.position.set(-60, 120, 40);
    this.scene.add(sun);

    // 공 + 그림자
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 })
    );
    this.scene.add(this.ball);
    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 })
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);

    this.holeGroup = null;
    this._total = 380;
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camInit = false;
    this._holedPrev = false;
    this._dropStart = 0;
    this._tPos = new THREE.Vector3();
    this._tLook = new THREE.Vector3();
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  snap() { this._camInit = false; }               // 카메라 즉시 이동(턴/홀 전환)
  ground(x, z) { return terrainH(x, z, this._total); }

  // -------------------------------------------------------------------------
  buildHole(game) {
    if (this.holeGroup) { disposeGroup(this.holeGroup); this.scene.remove(this.holeGroup); }
    const g = new THREE.Group();
    const total = game.hole.total;
    this._total = total;
    this._camInit = false;
    this._holedPrev = false;

    this.scene.fog = new THREE.Fog(0xcfe8ff, 100, Math.max(total + 200, 440));

    // 경사 지형(높이맵 + 정점 색)
    const L = total + 260, Wd = 340;
    const segZ = Math.min(260, Math.max(90, Math.round(L / 4)));
    const geo = new THREE.PlaneGeometry(Wd, L, 100, segZ);
    geo.rotateX(-Math.PI / 2);
    const meshZ = -total / 2 + 40;
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i), wz = pos.getZ(i) + meshZ;
      pos.setY(i, terrainH(wx, wz, total));
      const f = -wz;
      const distGreen = Math.hypot(wx, wz + total);
      if (distGreen < 17) col.set('#a7e89a');
      else if (Math.abs(wx) < 24) col.set((Math.floor(f / 9) % 2) ? '#57b552' : '#6bce60');
      else { const n = 0.5 + 0.5 * Math.sin(wx * 0.35 + wz * 0.2); col.setRGB(0.27 + 0.05 * n, 0.55 + 0.06 * n, 0.25 + 0.04 * n); }
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    ground.position.z = meshZ;
    g.add(ground);

    // 티 박스
    const tee = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x74d268, roughness: 1 })
    );
    tee.position.set(0, terrainH(0, 6, total) + 0.2, 6);
    g.add(tee);

    // 홀컵 + 깃대 + 깃발
    const gh = terrainH(0, -total, total);
    const cup = new THREE.Mesh(new THREE.CircleGeometry(0.9, 20), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    cup.rotation.x = -Math.PI / 2; cup.position.set(0, gh + 0.06, -total); g.add(cup);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 9, 8), new THREE.MeshStandardMaterial({ color: 0xf2f2f2 }));
    pole.position.set(0, gh + 4.5, -total); g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.4), new THREE.MeshStandardMaterial({ color: 0xe63946, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(2.1, gh + 8, -total); g.add(flag);
    this.flag = flag;

    // 나무 (지형 위에)
    for (const t of game.scenery.trees) {
      const tree = makeTree(t);
      tree.position.set(t.l, terrainH(t.l, -t.f, total), -t.f);
      g.add(tree);
    }
    // 연못
    for (const p of game.scenery.ponds) {
      const pond = new THREE.Mesh(
        new THREE.CircleGeometry(1, 32),
        new THREE.MeshStandardMaterial({ color: 0x2b7fb8, roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.9 })
      );
      pond.rotation.x = -Math.PI / 2;
      pond.scale.set(p.rl, p.rf, 1);
      pond.position.set(p.l, terrainH(p.l, -p.f, total) + 0.08, -p.f);
      g.add(pond);
    }

    g.add(makeMountains(total));

    this.scene.add(g);
    this.holeGroup = g;
  }

  // -------------------------------------------------------------------------
  render(now, game) {
    const h = game.hole;
    const T = this._total;
    if (game.activeColor) this.ball.material.color.set(game.activeColor());

    let bx = h.lateral, bz = -h.forward, by = terrainH(bx, bz, T) + 0.95, height = 0;

    if (game.flight) {
      this._holedPrev = false;
      const fl = game.flight;
      const p = clamp((now - fl.t0) / fl.dur, 0, 1);
      const f = lerp(fl.start.f, fl.end.f, p);
      const l = lerp(fl.start.l, fl.end.l, p);
      const apexH = fl.carry * (0.10 + fl.apex * 0.22);
      height = Math.sin(p * Math.PI) * apexH;
      bx = l; bz = -f; by = terrainH(bx, bz, T) + 0.95 + height;
      this.ball.visible = true;
      this._placeBall(bx, by, bz, height, T);
    } else if (h.holed) {
      this._renderDrop(now, h, T);
    } else {
      this._holedPrev = false;
      this.ball.visible = true;
      this._placeBall(bx, by, bz, 0, T);
    }

    if (this.flag) this.flag.rotation.y = Math.sin(now / 380) * 0.25;

    this._updateCamera(now, game, bx, by, bz);
    this.renderer.render(this.scene, this.camera);
  }

  _placeBall(bx, by, bz, height, T) {
    this.ball.position.set(bx, by, bz);
    const sy = terrainH(bx, bz, T) + 0.06;
    this.ballShadow.position.set(bx, sy, bz);
    const sc = clamp(1 - height / 120, 0.35, 1);
    this.ballShadow.scale.set(sc, sc, sc);
    this.ballShadow.visible = true;
  }

  // 홀인 : 컵으로 굴러가 → 컵 속으로 떨어짐
  _renderDrop(now, h, T) {
    if (!this._holedPrev) { this._holedPrev = true; this._dropStart = now; }
    const dt = (now - this._dropStart) / 1000;
    const cupX = 0, cupZ = -T, surf = terrainH(cupX, cupZ, T) + 0.95;
    if (dt >= 1.15) { this.ball.visible = false; this.ballShadow.visible = false; return; }
    this.ball.visible = true;
    let bx, bz, by;
    if (dt <= 0.55) {
      const r = ease(clamp(dt / 0.55, 0, 1));
      bx = lerp(h.lateral, cupX, r); bz = lerp(-h.forward, cupZ, r);
      by = terrainH(bx, bz, T) + 0.95;
      this.ballShadow.visible = true;
    } else {
      const drop = clamp((dt - 0.55) / 0.5, 0, 1);
      bx = cupX; bz = cupZ; by = surf - drop * 2.6;
      this.ballShadow.visible = false;
    }
    this.ball.position.set(bx, by, bz);
    this.ballShadow.position.set(bx, terrainH(bx, bz, T) + 0.06, bz);
    this.ballShadow.scale.set(1, 1, 1);
  }

  _updateCamera(now, game, bx, by, bz) {
    const h = game.hole, T = this._total;
    const tp = this._tPos, tl = this._tLook;

    if (game.flight) {
      const fl = game.flight;
      let sdx = fl.end.l - fl.start.l, sdz = -(fl.end.f - fl.start.f);
      const sl = Math.hypot(sdx, sdz) || 1; sdx /= sl; sdz /= sl;
      tp.set(bx - sdx * 15, by + 7, bz - sdz * 15);
      const gy = terrainH(tp.x, tp.z, T) + 4;
      if (tp.y < gy) tp.y = gy;
      tl.set(bx + sdx * 8, by * 0.5, bz + sdz * 8);
    } else {
      const ay = terrainH(h.lateral, -h.forward, T);
      tp.set(h.lateral * 0.6, ay + 5.5, -h.forward + 11);
      if (h.holed) {
        tl.set(0, terrainH(0, -T, T) + 0.6, -T);
      } else {
        const d = game.aimDirection();
        tl.set(h.lateral + d.nl * 60, ay + 1.4, -(h.forward + d.nf * 60));
      }
    }

    if (!this._camInit) { this._camPos.copy(tp); this._camLook.copy(tl); this._camInit = true; }
    this._camPos.lerp(tp, game.flight ? 0.12 : 0.2);
    this._camLook.lerp(tl, 0.2);
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);
  }
}

// ---------------------------------------------------------------------------
function makeTree(t) {
  const grp = new THREE.Group();
  const s = t.size;
  const trunkH = 3.2 * s;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32 * s, 0.46 * s, trunkH, 7),
    new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 1 })
  );
  trunk.position.y = trunkH / 2;
  grp.add(trunk);
  if (t.kind === 'pine') {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2f8f4a, roughness: 1 });
    for (let k = 0; k < 3; k++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(3.2 * s * (1 - k * 0.18), 3.6 * s, 9), mat);
      cone.position.y = trunkH + k * 2.4 * s + 1.4 * s;
      grp.add(cone);
    }
  } else {
    const mat = new THREE.MeshStandardMaterial({ color: 0x3fa055, roughness: 1 });
    const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(3.4 * s, 0), mat);
    canopy.position.y = trunkH + 2.6 * s;
    grp.add(canopy);
  }
  const sh = new THREE.Mesh(
    new THREE.CircleGeometry(3 * s, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 })
  );
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.05;
  grp.add(sh);
  return grp;
}

function makeMountains(total) {
  const grp = new THREE.Group();
  const mat1 = new THREE.MeshStandardMaterial({ color: 0x9fb8cf, roughness: 1, fog: false });
  const mat2 = new THREE.MeshStandardMaterial({ color: 0xb7c9da, roughness: 1, fog: false });
  const z = -total - 170;
  for (let i = 0; i < 10; i++) {
    const x = -360 + i * 80 + (i % 2) * 30;
    const hgt = 95 + (i % 3) * 55;
    const m = new THREE.Mesh(new THREE.ConeGeometry(75 + (i % 2) * 40, hgt, 5), i % 2 ? mat2 : mat1);
    m.position.set(x, hgt / 2 - 6, z - (i % 2) * 60);
    grp.add(m);
  }
  return grp;
}

function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#4aa8e8');
  grad.addColorStop(0.6, '#a9dcff');
  grad.addColorStop(1, '#dff2ff');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function disposeGroup(grp) {
  grp.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { Array.isArray(o.material) ? o.material.forEach((m) => m.dispose()) : o.material.dispose(); }
  });
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function ease(t) { return t * t * (3 - 2 * t); }
