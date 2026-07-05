// scene3d.js
// Three.js(CDN ESM) 로 1인칭 3D 골프 필드를 렌더링한다.
// 게임 상태(game.js)는 그대로 두고, 이 모듈이 3D 시각화만 담당한다.
// 좌표계 : 월드 x = 좌우(yd), z = -전진(yd), y = 높이. 1 yard ≈ 1 unit.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = makeSkyTexture();

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 5000);
    this.camera.position.set(0, 5.5, 12);

    // 조명
    const hemi = new THREE.HemisphereLight(0xffffff, 0x5a9e52, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff6d8, 0.65);
    sun.position.set(-60, 120, 40);
    this.scene.add(sun);

    // 공 + 그림자(영구 객체)
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

    this.holeGroup = null;   // 홀마다 교체되는 월드
    this._look = new THREE.Vector3();
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // 홀 월드 생성 (홀/코스 바뀔 때마다 호출)
  // -------------------------------------------------------------------------
  buildHole(game) {
    if (this.holeGroup) { disposeGroup(this.holeGroup); this.scene.remove(this.holeGroup); }
    const g = new THREE.Group();
    const total = game.hole.total;

    // 안개 : 거리감 + 원경 정리 (긴 홀은 핀이 자연스레 흐려짐)
    this.scene.fog = new THREE.Fog(0xcfe8ff, 90, Math.max(total + 180, 420));

    // 러프(넓은 바닥)
    const rough = new THREE.Mesh(
      new THREE.PlaneGeometry(320, total + 260),
      new THREE.MeshStandardMaterial({ color: 0x4f9e46, roughness: 1 })
    );
    rough.rotation.x = -Math.PI / 2;
    rough.position.set(0, 0, -total / 2 + 40);
    g.add(rough);

    // 페어웨이(밝은 통로)
    const fairway = new THREE.Mesh(
      new THREE.PlaneGeometry(52, total + 30),
      new THREE.MeshStandardMaterial({ color: 0x6fce62, roughness: 1 })
    );
    fairway.rotation.x = -Math.PI / 2;
    fairway.position.set(0, 0.02, -total / 2);
    g.add(fairway);

    // 잔디 줄무늬(페어웨이 위 밝고 어두운 띠)
    for (let i = 0; i < 16; i++) {
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(52, (total + 30) / 16),
        new THREE.MeshStandardMaterial({ color: i % 2 ? 0x66c65a : 0x74d268, roughness: 1 })
      );
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(0, 0.03, 10 - i * ((total + 30) / 16));
      g.add(stripe);
    }

    // 그린(홀 주변)
    const green = new THREE.Mesh(
      new THREE.CircleGeometry(17, 40),
      new THREE.MeshStandardMaterial({ color: 0xa7e89a, roughness: 1 })
    );
    green.rotation.x = -Math.PI / 2;
    green.position.set(0, 0.04, -total);
    g.add(green);

    // 티 박스
    const tee = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.3, 8),
      new THREE.MeshStandardMaterial({ color: 0x74d268, roughness: 1 })
    );
    tee.position.set(0, 0.15, 6);
    g.add(tee);

    // 홀컵 + 깃대 + 깃발
    const cup = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 20),
      new THREE.MeshBasicMaterial({ color: 0x111111 })
    );
    cup.rotation.x = -Math.PI / 2;
    cup.position.set(0, 0.06, -total);
    g.add(cup);

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 9, 8),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2 })
    );
    pole.position.set(0, 4.5, -total);
    g.add(pole);

    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 2.4),
      new THREE.MeshStandardMaterial({ color: 0xe63946, side: THREE.DoubleSide, roughness: 0.8 })
    );
    flag.position.set(2.1, 8, -total);
    g.add(flag);
    this.flag = flag;

    // 나무
    for (const t of game.scenery.trees) {
      g.add(makeTree(t));
    }
    // 연못
    for (const p of game.scenery.ponds) {
      const pond = new THREE.Mesh(
        new THREE.CircleGeometry(1, 32),
        new THREE.MeshStandardMaterial({ color: 0x2b7fb8, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.9 })
      );
      pond.rotation.x = -Math.PI / 2;
      pond.scale.set(p.rl, p.rf, 1);
      pond.position.set(p.l, 0.05, -p.f);
      g.add(pond);
    }

    // 원경 산맥
    g.add(makeMountains(total));

    this.scene.add(g);
    this.holeGroup = g;
  }

  // -------------------------------------------------------------------------
  // 매 프레임 렌더
  // -------------------------------------------------------------------------
  render(now, game) {
    const h = game.hole;
    let bx, by, bz, height = 0;

    if (game.flight) {
      const fl = game.flight;
      const p = clamp((now - fl.t0) / fl.dur, 0, 1);
      const f = lerp(fl.start.f, fl.end.f, p);
      const l = lerp(fl.start.l, fl.end.l, p);
      const apexH = fl.carry * (0.10 + fl.apex * 0.22);
      height = Math.sin(p * Math.PI) * apexH;
      bx = l; bz = -f; by = 0.95 + height;
    } else {
      bx = h.lateral; bz = -h.forward; by = 0.95;
    }

    this.ball.visible = !h.holed || !!game.flight;
    this.ball.position.set(bx, by, bz);
    this.ballShadow.position.set(bx, 0.06, bz);
    const sc = clamp(1 - height / 120, 0.35, 1);
    this.ballShadow.scale.set(sc, sc, sc);
    this.ballShadow.visible = this.ball.visible;

    // 카메라 : 샷 중엔 직전 라이에서 공을 좇고, 정지 시엔 라이에서 핀을 바라봄
    const anchor = game.flight ? game.flight.start : { f: h.forward, l: h.lateral };
    this.camera.position.set(anchor.l * 0.6, 5.5, -anchor.f + 11);
    if (game.flight) {
      this._look.set(bx, by, bz);
    } else {
      this._look.set(h.lateral * 0.3, 1.4, -h.total);
    }
    this.camera.lookAt(this._look);

    if (this.flag) this.flag.rotation.y = Math.sin(now / 380) * 0.25;

    this.renderer.render(this.scene, this.camera);
  }
}

// ---------------------------------------------------------------------------
// 메시 팩토리
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

  // 바닥 그림자
  const sh = new THREE.Mesh(
    new THREE.CircleGeometry(3 * s, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 })
  );
  sh.rotation.x = -Math.PI / 2;
  sh.position.y = 0.05;
  grp.add(sh);

  grp.position.set(t.l, 0, -t.f);
  return grp;
}

function makeMountains(total) {
  const grp = new THREE.Group();
  const mat1 = new THREE.MeshStandardMaterial({ color: 0x9fb8cf, roughness: 1, fog: false });
  const mat2 = new THREE.MeshStandardMaterial({ color: 0xb7c9da, roughness: 1, fog: false });
  const z = -total - 160;
  for (let i = 0; i < 9; i++) {
    const x = -320 + i * 80 + (i % 2) * 30;
    const hgt = 90 + (i % 3) * 55;
    const m = new THREE.Mesh(new THREE.ConeGeometry(70 + (i % 2) * 40, hgt, 5), i % 2 ? mat2 : mat1);
    m.position.set(x, hgt / 2 - 8, z - (i % 2) * 60);
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
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
function disposeGroup(grp) {
  grp.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
