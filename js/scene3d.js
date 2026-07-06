// scene3d.js
// Three.js 3D 열대 리조트 골프 필드. 도그렉(휜) 코스 지원 —
// 게임의 (forward,lateral) 스트립 좌표를 game.worldOf() 로 휜 월드 경로에 매핑.
// 경사 지형·야자수·바다/해변·모래벙커·워터해저드·공추적카메라·트레일/퍼프·홀인드롭.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const BEACH_IN = 56, BEACH_OUT = 82, SEA_Y = -2.6;

// 지형 높이(스트립 좌표) : l=좌우, f=전진. 티/그린 평탄, 가장자리는 바다로 하강.
function heightAt(l, f, total) {
  let h = Math.sin(f * 0.016 + 0.4) * 3.0
        + Math.sin(f * 0.006 + 1.1) * 4.0
        + Math.cos(l * 0.02 + 0.6) * 2.4
        + Math.sin((l + f) * 0.012) * 1.6;
  h *= smoothstep(0, 70, f) * smoothstep(0, 70, total - f);
  const al = Math.abs(l);
  if (al > BEACH_IN) h -= smoothstep(BEACH_IN, BEACH_OUT, al) * 10;
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

    const hemi = new THREE.HemisphereLight(0xfff4de, 0x6fae64, 1.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1cf, 0.85);
    sun.position.set(-70, 130, 60);
    this.scene.add(sun);

    const dimpleTex = makeGolfBallTexture();
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.98, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.02, map: dimpleTex, bumpMap: dimpleTex, bumpScale: 0.14 })
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

    // 먼지 퍼프
    this.puff = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 1.0, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    this.puff.rotation.x = -Math.PI / 2; this.puff.visible = false;
    this.scene.add(this.puff);
    this._puff = null;

    // ✨ 컬러 반짝이 파티클(스파클)
    const sparkTex = makeSparkTexture();
    this.sparkMax = 110;
    this.sparkPos = new Float32Array(this.sparkMax * 3);
    this.sparkCol = new Float32Array(this.sparkMax * 3);
    this.sparkBase = new Float32Array(this.sparkMax * 3);
    this.sparkVel = new Float32Array(this.sparkMax * 3);
    this.sparkLife = new Float32Array(this.sparkMax);
    for (let i = 0; i < this.sparkMax; i++) this.sparkPos[i * 3 + 1] = -99999;
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    sgeo.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3));
    this.sparks = new THREE.Points(sgeo, new THREE.PointsMaterial({
      size: 3.6, map: sparkTex, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this.sparks.frustumCulled = false;
    this.scene.add(this.sparks);
    this._sparkRR = 0;
    this._tmpCol = new THREE.Color();
    this._now = 0; this._lastNow = 0;

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

  // -------------------------------------------------------------------------
  buildHole(game) {
    if (this.holeGroup) { disposeGroup(this.holeGroup); this.scene.remove(this.holeGroup); }
    const g = new THREE.Group();
    const total = game.hole.total;
    this._total = total;
    this._camInit = false;
    this._holedPrev = false;

    this.scene.fog = new THREE.Fog(0xdcf0ff, 140, Math.max(total + 300, 560));

    // 경로 월드 범위(휜 코스 포함)
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (const q of game.path) { minx = Math.min(minx, q.x); maxx = Math.max(maxx, q.x); minz = Math.min(minz, q.z); maxz = Math.max(maxz, q.z); }
    const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
    const Wd = (maxx - minx) + 320, L = (maxz - minz) + 300;

    // 바다
    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(Wd + 900, L + 900),
      new THREE.MeshStandardMaterial({ color: 0x1f9fd6, roughness: 0.15, metalness: 0.35, transparent: true, opacity: 0.94 })
    );
    ocean.rotation.x = -Math.PI / 2; ocean.position.set(cx, SEA_Y, cz);
    g.add(ocean);

    // 경사 지형(정점 색: 페어웨이 줄무늬·러프·해변·그린) — 경로에 맞춰 색칠
    const segX = 120, segZ = Math.min(280, Math.max(90, Math.round(L / 4)));
    const geo = new THREE.PlaneGeometry(Wd, L, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + cx, wz = pos.getZ(i) + cz;
      const near = game.nearestOnPath(wx, wz);
      const f = near.f, l = near.l, al = Math.abs(l);
      pos.setY(i, heightAt(l, f, total));
      if (Math.hypot(l, f - total) < 17) col.set('#8fe07a');
      else if (al < 24 && f > -8 && f < total + 12) col.set((Math.floor(f / 14) % 2) ? '#5fbf52' : '#7ad86a');
      else if (al < BEACH_IN) { const n = 0.5 + 0.5 * Math.sin(wx * 0.35 + wz * 0.2); col.setRGB(0.30 + 0.05 * n, 0.60 + 0.06 * n, 0.27 + 0.04 * n); }
      else { const s = smoothstep(BEACH_IN, BEACH_IN + 14, al); col.setRGB(0.90 - s * 0.1, 0.85 - s * 0.08, 0.68 - s * 0.05); }
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    ground.position.set(cx, 0, cz);
    g.add(ground);

    const put = (mesh, f, l, yOff = 0) => { const w = game.worldOf(f, l); mesh.position.set(w.x, heightAt(l, f, total) + yOff, w.z); };

    // 모래 벙커
    const bunkerMat = new THREE.MeshStandardMaterial({ color: 0xf2e4bf, roughness: 1 });
    for (const b of (game.scenery.bunkers || [])) {
      const sand = new THREE.Mesh(new THREE.CircleGeometry(b.r, 24), bunkerMat);
      sand.rotation.x = -Math.PI / 2; sand.scale.set(1, 1.3, 1);
      put(sand, b.f, b.l, 0.06); g.add(sand);
    }

    // 티 박스
    const tee = new THREE.Mesh(new THREE.BoxGeometry(14, 0.4, 8), new THREE.MeshStandardMaterial({ color: 0x74d268, roughness: 1 }));
    const tw = game.worldOf(-3, 0); tee.position.set(tw.x, heightAt(0, 3, total) + 0.2, tw.z);
    g.add(tee);

    // 홀컵 + 깃대 + 깃발
    const gy = heightAt(0, total, total);
    const gw = game.worldOf(total, 0);
    const cup = new THREE.Mesh(new THREE.CircleGeometry(0.9, 20), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    cup.rotation.x = -Math.PI / 2; cup.position.set(gw.x, gy + 0.06, gw.z); g.add(cup);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 9, 8), new THREE.MeshStandardMaterial({ color: 0xf7f7f7 }));
    pole.position.set(gw.x, gy + 4.5, gw.z); g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.4), new THREE.MeshStandardMaterial({ color: 0xff5a3c, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(gw.x + 2.1, gy + 8, gw.z); g.add(flag);
    this.flag = flag;

    // 야자수
    for (const t of game.scenery.trees) {
      const palm = makePalm(t);
      const w = game.worldOf(t.f, t.l);
      palm.position.set(w.x, heightAt(t.l, t.f, total), w.z);
      g.add(palm);
    }
    // 워터 해저드 + 모래 테두리
    for (const p of game.scenery.ponds) {
      const w = game.worldOf(p.f, p.l);
      const y = heightAt(p.l, p.f, total);
      const rim = new THREE.Mesh(new THREE.CircleGeometry(1, 30), new THREE.MeshStandardMaterial({ color: 0xeaddb8, roughness: 1 }));
      rim.rotation.x = -Math.PI / 2; rim.scale.set(p.rl + 3, p.rf + 3, 1); rim.position.set(w.x, y + 0.05, w.z); g.add(rim);
      const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 32),
        new THREE.MeshStandardMaterial({ color: 0x2aa6d6, roughness: 0.12, metalness: 0.25, transparent: true, opacity: 0.9 }));
      pond.rotation.x = -Math.PI / 2; pond.scale.set(p.rl, p.rf, 1); pond.position.set(w.x, y + 0.1, w.z); g.add(pond);
    }

    g.add(makeIslands(cx, minz - 190));

    this.scene.add(g);
    this.holeGroup = g;
  }

  // -------------------------------------------------------------------------
  render(now, game) {
    const h = game.hole;
    const T = this._total;
    this._now = now;
    const dt = clamp((now - this._lastNow) / 1000, 0, 0.05) || 0.016;
    this._lastNow = now;
    if (game.activeColor) this.ball.material.color.set(game.activeColor());

    // 현재 공의 스트립 좌표 → 월드
    let f = h.forward, l = h.lateral, height = 0;
    const flying = !!game.flight;

    if (flying && !this._wasFlying) {
      this._trail.length = 0;
      const w0 = game.worldOf(h.forward, h.lateral);
      const gy0 = heightAt(h.lateral, h.forward, T);
      this._spawnPuff(now, w0.x, gy0 + 0.3, w0.z, 0xffe08a, 6, 0.45);
      this._burstSparks(w0.x, gy0 + 1.2, w0.z, 6);    // 임팩트 폭죽(소량)
    } else if (!flying && this._wasFlying && !h.holed) {
      const w1 = game.worldOf(h.forward, h.lateral);
      const gy1 = heightAt(h.lateral, h.forward, T);
      this._spawnPuff(now, w1.x, gy1 + 0.3, w1.z, 0xa0e8ff, 5, 0.5);
      this._burstSparks(w1.x, gy1 + 1.0, w1.z, 5);    // 착지 폭죽(소량)
    }
    this._wasFlying = flying;

    let bx, by, bz;
    if (flying) {
      this._holedPrev = false;
      const fl = game.flight;
      const p = clamp((now - fl.t0) / fl.dur, 0, 1);
      f = lerp(fl.start.f, fl.end.f, p);
      l = lerp(fl.start.l, fl.end.l, p);
      const apexH = fl.carry * (0.10 + fl.apex * 0.22);
      height = Math.sin(p * Math.PI) * apexH;
      const w = game.worldOf(f, l);
      bx = w.x; bz = w.z; by = heightAt(l, f, T) + 0.95 + height;
      this.ball.visible = true;
      this._placeBall(bx, by, bz, height, heightAt(l, f, T));
      this.ball.rotation.x += 0.45; this.ball.rotation.z += 0.32;
      this._trail.unshift([bx, by, bz]);
      if (this._trail.length > this.trailMax) this._trail.pop();
      // ✨ 꼬리에 살짝 반짝이만(공을 가리지 않게 소량)
      if ((this._sparkTick = (this._sparkTick || 0) + 1) % 2 === 0) this._spawnSpark(bx, by, bz);
    } else if (h.holed) {
      this._renderDrop(now, game, T);
      const wb = game.worldOf(h.forward, h.lateral); bx = wb.x; bz = wb.z; by = heightAt(l, f, T) + 0.95;
    } else {
      this._holedPrev = false;
      const w = game.worldOf(f, l);
      bx = w.x; bz = w.z; by = heightAt(l, f, T) + 0.95;
      this.ball.visible = true;
      this._placeBall(bx, by, bz, 0, heightAt(l, f, T));
    }

    if (!flying && this._trail.length) { this._trail.pop(); this._trail.pop(); }
    this._updateTrail();
    this._animPuff(now);
    this._updateSparks(dt);
    if (this.flag) this.flag.rotation.y = Math.sin(now / 380) * 0.25;

    this._updateCamera(now, game, bx, by, bz);
    this.renderer.render(this.scene, this.camera);
  }

  _placeBall(bx, by, bz, height, groundY) {
    this.ball.position.set(bx, by, bz);
    this.ballShadow.position.set(bx, groundY + 0.06, bz);
    const sc = clamp(1 - height / 120, 0.35, 1);
    this.ballShadow.scale.set(sc, sc, sc);
    this.ballShadow.visible = true;
  }

  _renderDrop(now, game, T) {
    if (!this._holedPrev) { this._holedPrev = true; this._dropStart = now; }
    const h = game.hole;
    const dt = (now - this._dropStart) / 1000;
    const cup = game.worldOf(T, 0);
    const surf = heightAt(0, T, T) + 0.95;
    if (dt >= 1.15) { this.ball.visible = false; this.ballShadow.visible = false; return; }
    this.ball.visible = true;
    let bx, bz, by, gy;
    if (dt <= 0.55) {
      const r = ease(clamp(dt / 0.55, 0, 1));
      const f = lerp(h.forward, T, r), l = lerp(h.lateral, 0, r);
      const w = game.worldOf(f, l);
      bx = w.x; bz = w.z; gy = heightAt(l, f, T); by = gy + 0.95; this.ballShadow.visible = true;
    } else {
      const drop = clamp((dt - 0.55) / 0.5, 0, 1);
      bx = cup.x; bz = cup.z; gy = heightAt(0, T, T); by = surf - drop * 2.6; this.ballShadow.visible = false;
    }
    this.ball.position.set(bx, by, bz);
    this.ballShadow.position.set(bx, gy + 0.06, bz);
    this.ballShadow.scale.set(1, 1, 1);
  }

  _updateTrail() {
    const n = this._trail.length; const geo = this.trail.geometry;
    if (n < 2) { this.trail.visible = false; geo.setDrawRange(0, 0); return; }
    this.trail.visible = true;
    const baseHue = (this._now * 0.0004) % 1;   // 시간에 따라 무지개가 흐름
    const c = this._tmpCol;
    for (let i = 0; i < n; i++) {
      const p = this._trail[i];
      this.trailPos[i * 3] = p[0]; this.trailPos[i * 3 + 1] = p[1]; this.trailPos[i * 3 + 2] = p[2];
      const a = 1 - i / n;                         // 꼬리로 갈수록 옅게
      c.setHSL((baseHue + i / n * 0.85) % 1, 1, 0.55);
      this.trailCol[i * 3] = c.r * (0.35 + a * 0.65);
      this.trailCol[i * 3 + 1] = c.g * (0.35 + a * 0.65);
      this.trailCol[i * 3 + 2] = c.b * (0.35 + a * 0.65);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, n);
  }

  // ✨ 스파클 파티클
  _spawnSpark(x, y, z) {
    let idx = -1;
    for (let i = 0; i < this.sparkMax; i++) { if (this.sparkLife[i] <= 0) { idx = i; break; } }
    if (idx < 0) { idx = this._sparkRR; this._sparkRR = (this._sparkRR + 1) % this.sparkMax; }
    const j = idx * 3;
    this.sparkPos[j] = x + (Math.random() - 0.5) * 1.4;
    this.sparkPos[j + 1] = y + (Math.random() - 0.5) * 1.4;
    this.sparkPos[j + 2] = z + (Math.random() - 0.5) * 1.4;
    this.sparkVel[j] = (Math.random() - 0.5) * 3;
    this.sparkVel[j + 1] = Math.random() * 2.5 + 0.5;   // 경로에 붙게 살짝만 뜸
    this.sparkVel[j + 2] = (Math.random() - 0.5) * 3;
    this._tmpCol.setHSL(Math.random(), 0.95, 0.55);
    this.sparkBase[j] = this._tmpCol.r; this.sparkBase[j + 1] = this._tmpCol.g; this.sparkBase[j + 2] = this._tmpCol.b;
    this.sparkLife[idx] = 1;
  }
  _burstSparks(x, y, z, count) { for (let i = 0; i < count; i++) this._spawnSpark(x, y, z); }
  _updateSparks(dt) {
    let any = false;
    for (let i = 0; i < this.sparkMax; i++) {
      if (this.sparkLife[i] <= 0) continue;
      any = true;
      const j = i * 3;
      this.sparkLife[i] -= dt / 0.55;
      if (this.sparkLife[i] <= 0) { this.sparkPos[j + 1] = -99999; this.sparkCol[j] = this.sparkCol[j + 1] = this.sparkCol[j + 2] = 0; continue; }
      this.sparkVel[j + 1] -= 6 * dt;            // 중력
      this.sparkPos[j] += this.sparkVel[j] * dt;
      this.sparkPos[j + 1] += this.sparkVel[j + 1] * dt;
      this.sparkPos[j + 2] += this.sparkVel[j + 2] * dt;
      const tw = 0.5 + 0.35 * Math.sin(this._now * 0.03 + i * 1.7); // 반짝임(차분)
      const b = this.sparkLife[i] * tw * 0.85;
      this.sparkCol[j] = this.sparkBase[j] * b;
      this.sparkCol[j + 1] = this.sparkBase[j + 1] * b;
      this.sparkCol[j + 2] = this.sparkBase[j + 2] * b;
    }
    if (any || this._sparksWereOn) {
      this.sparks.geometry.attributes.position.needsUpdate = true;
      this.sparks.geometry.attributes.color.needsUpdate = true;
    }
    this._sparksWereOn = any;
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
      const s = game.worldOf(game.flight.start.f, game.flight.start.l);
      const e = game.worldOf(game.flight.end.f, game.flight.end.l);
      let sdx = e.x - s.x, sdz = e.z - s.z;
      const sl = Math.hypot(sdx, sdz) || 1; sdx /= sl; sdz /= sl;
      tp.set(bx - sdx * 15, by + 7, bz - sdz * 15);
      const gy = heightAt(0, Math.max(0, h.forward), T) + 4;
      if (tp.y < gy) tp.y = gy;
      tl.set(bx + sdx * 8, by * 0.5, bz + sdz * 8);
    } else {
      const w = game.worldOf(h.forward, h.lateral);
      const ay = heightAt(h.lateral, h.forward, T);
      tp.set(w.x - w.hx * 11, ay + 5.5, w.z - w.hz * 11);
      if (h.holed) {
        const c = game.worldOf(T, 0);
        tl.set(c.x, heightAt(0, T, T) + 0.6, c.z);
      } else {
        const d = game.aimDirection();
        const nx = -w.hz, nz = w.hx;
        const wdx = w.hx * d.nf + nx * d.nl, wdz = w.hz * d.nf + nz * d.nl;
        tl.set(w.x + wdx * 60, ay + 1.4, w.z + wdz * 60);
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
function makePalm(t) {
  const grp = new THREE.Group();
  const s = t.size;
  const trunkH = 8 * s + 3;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34 * s, 0.62 * s, trunkH, 8),
    new THREE.MeshStandardMaterial({ color: 0xc0a578, roughness: 1 })
  );
  trunk.position.y = trunkH / 2; trunk.rotation.z = 0.05; grp.add(trunk);

  const cocoMat = new THREE.MeshStandardMaterial({ color: 0x5a4326, roughness: 1 });
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.45 * s, 8, 6), cocoMat);
    const a = i / 3 * Math.PI * 2;
    c.position.set(Math.cos(a) * 0.7 * s, trunkH - 0.6, Math.sin(a) * 0.7 * s); grp.add(c);
  }

  const frondMat = new THREE.MeshStandardMaterial({ color: 0x3f9e3a, roughness: 1, side: THREE.DoubleSide });
  const crown = new THREE.Group(); crown.position.y = trunkH; grp.add(crown);
  const N = 7;
  for (let i = 0; i < N; i++) {
    const arm = new THREE.Group(); arm.rotation.y = i / N * Math.PI * 2 + 0.2; crown.add(arm);
    const frond = new THREE.Mesh(new THREE.ConeGeometry(0.9 * s, 6.5 * s, 4), frondMat);
    frond.scale.set(1, 1, 0.22);
    frond.rotation.z = -Math.PI / 2 - 0.25;
    frond.position.set(3.0 * s, -0.2 * s, 0);
    arm.add(frond);
  }
  const sh = new THREE.Mesh(new THREE.CircleGeometry(2.6 * s, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 }));
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.05; grp.add(sh);
  return grp;
}

function makeIslands(cx, z) {
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x6fb98f, roughness: 1 });
  for (let i = 0; i < 8; i++) {
    const x = cx - 420 + i * 110 + (i % 2) * 40;
    const hgt = 34 + (i % 3) * 22, base = 70 + (i % 2) * 40;
    const m = new THREE.Mesh(new THREE.SphereGeometry(base, 8, 6), mat);
    m.scale.set(1, hgt / base, 1);
    m.position.set(x, SEA_Y, z - (i % 2) * 80);
    grp.add(m);
  }
  return grp;
}

// 골프공 딤플 텍스처 : 흰 바탕에 오목한 딤플 격자 (map + bumpMap)
function makeGolfBallTexture() {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, s, s);
  const cols = 9, rows = 9, cell = s / cols, r = cell * 0.44;
  for (let gy = 0; gy <= rows; gy++) {
    for (let gx = 0; gx <= cols; gx++) {
      const off = (gy % 2) ? cell / 2 : 0;
      const x = gx * cell + off, y = gy * (s / rows);
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.55, '#eef1f4');
      g.addColorStop(0.88, '#c4ccd2');   // 오목한 그림자 링
      g.addColorStop(1, '#f2f5f7');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 반짝이 스프라이트 텍스처 : 부드러운 광채 + 십자 별빛
function makeSparkTexture() {
  const s = 64, c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  // 십자 별빛
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(s / 2, 6); ctx.lineTo(s / 2, s - 6);
  ctx.moveTo(6, s / 2); ctx.lineTo(s - 6, s / 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
