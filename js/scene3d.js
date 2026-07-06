// scene3d.js
// Three.js(CDN ESM) 3D 골프 필드 — 열대 리조트 코스.
// 경사 지형(높이맵) · 야자수 · 바다/해변 · 모래 벙커 · 워터해저드 ·
// 공 추적 카메라 · 비행 트레일/퍼프 · 홀인 드롭.
// 좌표계 : x = 좌우(yd), z = -전진(yd), y = 높이. 1 yard ≈ 1 unit.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const BEACH_IN = 56, BEACH_OUT = 82;   // 해변→바다 전이 구간(|x|)
const SEA_Y = -2.6;

// 지형 높이 : 티/그린 평평, 페어웨이 완만한 경사, 가장자리는 바다로 하강.
function terrainH(x, z, total) {
  const f = -z;
  let h = Math.sin(f * 0.016 + 0.4) * 3.0
        + Math.sin(f * 0.006 + 1.1) * 4.0
        + Math.cos(x * 0.02 + 0.6) * 2.4
        + Math.sin((x + f) * 0.012) * 1.6;
  const edge = smoothstep(0, 70, f) * smoothstep(0, 70, total - f);
  h *= edge;
  const ax = Math.abs(x);
  if (ax > BEACH_IN) h -= smoothstep(BEACH_IN, BEACH_OUT, ax) * 10;  // 물가로 하강
  return h;
}
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = makeSkyTexture();

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 7000);

    // 따뜻한 열대 조명
    const hemi = new THREE.HemisphereLight(0xfff4de, 0x6fae64, 1.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1cf, 0.85);
    sun.position.set(-70, 130, 60);
    this.scene.add(sun);

    // 공 + 그림자
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 })
    );
    this.scene.add(this.ball);
    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 })
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballShadow);

    // 비행 트레일
    this.trailMax = 28;
    this.trailPos = new Float32Array(this.trailMax * 3);
    this.trailCol = new Float32Array(this.trailMax * 3);
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    tgeo.setAttribute('color', new THREE.BufferAttribute(this.trailCol, 3));
    tgeo.setDrawRange(0, 0);
    this.trail = new THREE.Line(tgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    this.trail.frustumCulled = false; this.trail.visible = false;
    this.scene.add(this.trail);
    this._trail = []; this._wasFlying = false;

    // 임팩트/착지 먼지 퍼프
    this.puff = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 1.0, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    this.puff.rotation.x = -Math.PI / 2; this.puff.visible = false;
    this.scene.add(this.puff);
    this._puff = null;

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
  snap() { this._camInit = false; }
  ground(x, z) { return terrainH(x, z, this._total); }

  // -------------------------------------------------------------------------
  buildHole(game) {
    if (this.holeGroup) { disposeGroup(this.holeGroup); this.scene.remove(this.holeGroup); }
    const g = new THREE.Group();
    const total = game.hole.total;
    this._total = total;
    this._camInit = false;
    this._holedPrev = false;

    this.scene.fog = new THREE.Fog(0xdcf0ff, 130, Math.max(total + 260, 520));

    // 바다
    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, total + 900),
      new THREE.MeshStandardMaterial({ color: 0x1f9fd6, roughness: 0.15, metalness: 0.35, transparent: true, opacity: 0.94 })
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.set(0, SEA_Y, -total / 2 + 40);
    g.add(ocean);

    // 경사 지형(높이맵 + 정점 색: 페어웨이 줄무늬·러프·해변)
    const L = total + 260, Wd = 360;
    const segZ = Math.min(280, Math.max(90, Math.round(L / 4)));
    const geo = new THREE.PlaneGeometry(Wd, L, 110, segZ);
    geo.rotateX(-Math.PI / 2);
    const meshZ = -total / 2 + 40;
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i), wz = pos.getZ(i) + meshZ;
      pos.setY(i, terrainH(wx, wz, total));
      const f = -wz, ax = Math.abs(wx);
      const distGreen = Math.hypot(wx, wz + total);
      if (distGreen < 17) col.set('#8fe07a');
      else if (ax < 24 && f > -8 && f < total + 12) col.set((Math.floor(f / 14) % 2) ? '#5fbf52' : '#7ad86a');
      else if (ax < BEACH_IN) { const n = 0.5 + 0.5 * Math.sin(wx * 0.35 + wz * 0.2); col.setRGB(0.30 + 0.05 * n, 0.60 + 0.06 * n, 0.27 + 0.04 * n); }
      else { const s = smoothstep(BEACH_IN, BEACH_IN + 14, ax); col.setRGB(0.90 - s * 0.1, 0.85 - s * 0.08, 0.68 - s * 0.05); } // 모래 해변
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    ground.position.z = meshZ;
    g.add(ground);

    // 모래 벙커
    const bunkerMat = new THREE.MeshStandardMaterial({ color: 0xf2e4bf, roughness: 1 });
    for (const b of (game.scenery.bunkers || [])) {
      const sand = new THREE.Mesh(new THREE.CircleGeometry(b.r, 24), bunkerMat);
      sand.rotation.x = -Math.PI / 2;
      sand.position.set(b.l, terrainH(b.l, -b.f, total) + 0.06, -b.f);
      sand.scale.set(1, 1.3, 1);
      g.add(sand);
    }

    // 티 박스
    const tee = new THREE.Mesh(new THREE.BoxGeometry(14, 0.4, 8), new THREE.MeshStandardMaterial({ color: 0x74d268, roughness: 1 }));
    tee.position.set(0, terrainH(0, 6, total) + 0.2, 6);
    g.add(tee);

    // 홀컵 + 깃대 + 깃발
    const gh = terrainH(0, -total, total);
    const cup = new THREE.Mesh(new THREE.CircleGeometry(0.9, 20), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    cup.rotation.x = -Math.PI / 2; cup.position.set(0, gh + 0.06, -total); g.add(cup);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 9, 8), new THREE.MeshStandardMaterial({ color: 0xf7f7f7 }));
    pole.position.set(0, gh + 4.5, -total); g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.4), new THREE.MeshStandardMaterial({ color: 0xff5a3c, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(2.1, gh + 8, -total); g.add(flag);
    this.flag = flag;

    // 야자수
    for (const t of game.scenery.trees) {
      const palm = makePalm(t);
      palm.position.set(t.l, terrainH(t.l, -t.f, total), -t.f);
      g.add(palm);
    }
    // 워터 해저드(연못) + 모래 테두리
    for (const p of game.scenery.ponds) {
      const rim = new THREE.Mesh(new THREE.CircleGeometry(1, 30), new THREE.MeshStandardMaterial({ color: 0xeaddb8, roughness: 1 }));
      rim.rotation.x = -Math.PI / 2; rim.scale.set(p.rl + 3, p.rf + 3, 1);
      rim.position.set(p.l, terrainH(p.l, -p.f, total) + 0.05, -p.f); g.add(rim);
      const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 32),
        new THREE.MeshStandardMaterial({ color: 0x2aa6d6, roughness: 0.12, metalness: 0.25, transparent: true, opacity: 0.9 }));
      pond.rotation.x = -Math.PI / 2; pond.scale.set(p.rl, p.rf, 1);
      pond.position.set(p.l, terrainH(p.l, -p.f, total) + 0.1, -p.f); g.add(pond);
    }

    // 원경 섬/언덕(낮고 초록, 안개로 흐림)
    g.add(makeIslands(total));

    this.scene.add(g);
    this.holeGroup = g;
  }

  // -------------------------------------------------------------------------
  render(now, game) {
    const h = game.hole;
    const T = this._total;
    if (game.activeColor) this.ball.material.color.set(game.activeColor());

    let bx = h.lateral, bz = -h.forward, by = terrainH(bx, bz, T) + 0.95, height = 0;

    const flying = !!game.flight;
    if (flying && !this._wasFlying) {
      this._trail.length = 0;
      const sx = h.lateral, sz = -h.forward;
      this._spawnPuff(now, sx, terrainH(sx, sz, T) + 0.3, sz, 0xf3ead4, 5, 0.4);
    } else if (!flying && this._wasFlying && !h.holed) {
      this._spawnPuff(now, bx, terrainH(bx, bz, T) + 0.3, bz, 0xe8dcc0, 4.5, 0.5);
    }
    this._wasFlying = flying;

    if (flying) {
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
      this.ball.rotation.x += 0.45; this.ball.rotation.z += 0.32;
      this._trail.unshift([bx, by, bz]);
      if (this._trail.length > this.trailMax) this._trail.pop();
    } else if (h.holed) {
      this._renderDrop(now, h, T);
    } else {
      this._holedPrev = false;
      this.ball.visible = true;
      this._placeBall(bx, by, bz, 0, T);
    }

    if (!flying && this._trail.length) { this._trail.pop(); this._trail.pop(); }
    this._updateTrail();
    this._animPuff(now);

    if (this.flag) this.flag.rotation.y = Math.sin(now / 380) * 0.25;

    this._updateCamera(now, game, bx, by, bz);
    this.renderer.render(this.scene, this.camera);
  }

  _placeBall(bx, by, bz, height, T) {
    this.ball.position.set(bx, by, bz);
    this.ballShadow.position.set(bx, terrainH(bx, bz, T) + 0.06, bz);
    const sc = clamp(1 - height / 120, 0.35, 1);
    this.ballShadow.scale.set(sc, sc, sc);
    this.ballShadow.visible = true;
  }

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
      by = terrainH(bx, bz, T) + 0.95; this.ballShadow.visible = true;
    } else {
      const drop = clamp((dt - 0.55) / 0.5, 0, 1);
      bx = cupX; bz = cupZ; by = surf - drop * 2.6; this.ballShadow.visible = false;
    }
    this.ball.position.set(bx, by, bz);
    this.ballShadow.position.set(bx, terrainH(bx, bz, T) + 0.06, bz);
    this.ballShadow.scale.set(1, 1, 1);
  }

  _updateTrail() {
    const n = this._trail.length;
    const geo = this.trail.geometry;
    if (n < 2) { this.trail.visible = false; geo.setDrawRange(0, 0); return; }
    this.trail.visible = true;
    for (let i = 0; i < n; i++) {
      const p = this._trail[i];
      this.trailPos[i * 3] = p[0]; this.trailPos[i * 3 + 1] = p[1]; this.trailPos[i * 3 + 2] = p[2];
      const a = 1 - i / n;
      this.trailCol[i * 3] = a; this.trailCol[i * 3 + 1] = a; this.trailCol[i * 3 + 2] = a * 0.9 + 0.1;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, n);
  }

  _spawnPuff(now, x, y, z, color, rMax, dur) { this._puff = { t0: now, x, y, z, color, rMax, dur }; }
  _animPuff(now) {
    const p = this._puff;
    if (!p) { this.puff.visible = false; return; }
    const t = (now - p.t0) / 1000 / p.dur;
    if (t >= 1) { this.puff.visible = false; this._puff = null; return; }
    this.puff.visible = true;
    this.puff.material.color.set(p.color);
    this.puff.material.opacity = (1 - t) * 0.6;
    const r = 0.5 + t * p.rMax;
    this.puff.scale.set(r, r, r);
    this.puff.position.set(p.x, p.y, p.z);
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
      if (h.holed) tl.set(0, terrainH(0, -T, T) + 0.6, -T);
      else { const d = game.aimDirection(); tl.set(h.lateral + d.nl * 60, ay + 1.4, -(h.forward + d.nf * 60)); }
    }
    if (!this._camInit) { this._camPos.copy(tp); this._camLook.copy(tl); this._camInit = true; }
    this._camPos.lerp(tp, game.flight ? 0.12 : 0.2);
    this._camLook.lerp(tl, 0.2);
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);
  }
}

// ---------------------------------------------------------------------------
// 야자수
function makePalm(t) {
  const grp = new THREE.Group();
  const s = t.size;
  const trunkH = 8 * s + 3;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34 * s, 0.62 * s, trunkH, 8),
    new THREE.MeshStandardMaterial({ color: 0xc0a578, roughness: 1 })
  );
  trunk.position.y = trunkH / 2;
  trunk.rotation.z = 0.05;
  grp.add(trunk);

  // 코코넛
  const cocoMat = new THREE.MeshStandardMaterial({ color: 0x5a4326, roughness: 1 });
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.45 * s, 8, 6), cocoMat);
    const a = i / 3 * Math.PI * 2;
    c.position.set(Math.cos(a) * 0.7 * s, trunkH - 0.6, Math.sin(a) * 0.7 * s);
    grp.add(c);
  }

  // 잎(fronds) : 방사 + 처짐
  const frondMat = new THREE.MeshStandardMaterial({ color: 0x3f9e3a, roughness: 1, side: THREE.DoubleSide });
  const crown = new THREE.Group();
  crown.position.y = trunkH;
  grp.add(crown);
  const N = 7;
  for (let i = 0; i < N; i++) {
    const arm = new THREE.Group();
    arm.rotation.y = i / N * Math.PI * 2 + 0.2;
    crown.add(arm);
    const frond = new THREE.Mesh(new THREE.ConeGeometry(0.9 * s, 6.5 * s, 4), frondMat);
    frond.scale.set(1, 1, 0.22);              // 납작한 잎
    frond.rotation.z = -Math.PI / 2 - 0.25;   // 밖으로 눕히고 살짝 처짐
    frond.position.set(3.0 * s, -0.2 * s, 0);
    arm.add(frond);
  }

  const sh = new THREE.Mesh(
    new THREE.CircleGeometry(2.6 * s, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 })
  );
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.05;
  grp.add(sh);
  return grp;
}

// 원경 섬/언덕 (낮고 초록, 안개로 자연스럽게 흐려짐)
function makeIslands(total) {
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x6fb98f, roughness: 1 });
  const z = -total - 190;
  for (let i = 0; i < 8; i++) {
    const x = -420 + i * 110 + (i % 2) * 40;
    const hgt = 34 + (i % 3) * 22;
    const m = new THREE.Mesh(new THREE.SphereGeometry(70 + (i % 2) * 40, 8, 6), mat);
    m.scale.set(1, hgt / (70 + (i % 2) * 40), 1);
    m.position.set(x, SEA_Y, z - (i % 2) * 80);
    grp.add(m);
  }
  return grp;
}

function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#2ea3e8');
  grad.addColorStop(0.5, '#8fd4f7');
  grad.addColorStop(1, '#eaf8ff');
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
