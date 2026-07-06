// game.js
// 골프 게임 상태 · 물리(비거리/정확도/바람) · 코스 · 조경 데이터 · 미니맵(2D HUD).
// 1인칭 필드는 scene3d.js(Three.js)가 3D로 렌더링한다.

// ---------------------------------------------------------------------------
// 클럽 : 최대 비거리(yd), 로프트, 좌우 오차 상한(yd)
// ---------------------------------------------------------------------------
export const CLUBS = {
  driver: { key: 'driver', name: '드라이버', maxYards: 260, loft: 12, sideMax: 34, color: '#ff7a45' },
  iron:   { key: 'iron',   name: '아이언',   maxYards: 165, loft: 26, sideMax: 20, color: '#4dabf7' },
  putter: { key: 'putter', name: '퍼터',     maxYards: 18,  loft: 2,  sideMax: 4,  color: '#20c997' },
};

// ---------------------------------------------------------------------------
// 라운딩 코스 : 난이도 · 바람 · 관용도(forgive) · 홀 구성
// ---------------------------------------------------------------------------
export const COURSES = [
  {
    id: 'practice', name: '햇살 연습 그린', difficulty: '초급', stars: 1,
    desc: '짧고 넓은 페어웨이, 바람 없음. 처음이라면 여기부터.',
    windMax: 0, forgive: 1.5,
    holes: [ { par: 3, total: 150 }, { par: 3, total: 175 }, { par: 4, total: 300 } ],
  },
  {
    id: 'greenhill', name: '그린힐 컨트리클럽', difficulty: '중급', stars: 2,
    desc: '정직한 거리와 약한 바람. 오른쪽으로 휘는 도그렉 홀 포함.',
    windMax: 7, forgive: 1.0,
    holes: [ { par: 4, total: 380 }, { par: 3, total: 190 }, { par: 5, total: 505, bendDeg: 26 }, { par: 4, total: 410, bendDeg: -18 } ],
  },
  {
    id: 'championship', name: '챔피언십 링크스', difficulty: '고급', stars: 3,
    desc: '강풍·좁은 페어웨이·워터/벙커 지뢰밭·빠른 그린·작은 홀컵. 극악 난이도.',
    windMax: 26, forgive: 0.5, greenSpeed: 1.4, cupMul: 0.78,
    holes: [ { par: 5, total: 580, bendDeg: 26 }, { par: 4, total: 455, bendDeg: -34 }, { par: 3, total: 235 }, { par: 4, total: 480, bendDeg: 36 }, { par: 5, total: 610, bendDeg: -24 } ],
  },
];

export const PLAYER_COLORS = ['#ffffff', '#ffe066', '#74c0fc', '#ff8787'];

export class GolfGame {
  constructor(miniCanvas) {
    this.mini = miniCanvas;
    this.mctx = miniCanvas.getContext('2d');

    this.course = COURSES[0];
    this.holeIndex = 0;
    this.club = CLUBS.driver;

    // 멀티플레이어(로컬 핫시트) — 각자 같은 홀을 순서대로 플레이
    this.players = [{ name: 'P1', color: PLAYER_COLORS[0], holes: [] }];
    this.activeIdx = 0;

    // 콜백 (main.js 주입)
    this.onMessage = () => {};
    this.onState = () => {};
    this.onHoled = () => {};
    this.onShot = () => {};
    this.onCourseComplete = () => {};
    this.onHoleReady = () => {};   // 3D 월드 재생성 트리거
    this.onWater = () => {};
    this.onLand = () => {};        // 일반 착지
    this.onTurn = () => {};

    this.flight = null;
    this.lastShotYards = 0;
    this.wind = { cross: 0, head: 0 };
    this.scenery = { trees: [], ponds: [], bunkers: [] };
    this.aim = 0;   // 조준 각도(도). - 왼쪽 / + 오른쪽. 기본 0 = 핀 정조준.

    this._newHole();
  }

  get numPlayers() { return this.players.length; }
  activeColor() { return this.players[this.activeIdx].color; }
  activeName() { return this.players[this.activeIdx].name; }

  // 조준 조절(방향키). 홀마다 0으로 리셋.
  adjustAim(deg) {
    if (this.isBusy()) return;
    this.aim = clamp(this.aim + deg, -35, 35);
    this._notify();
  }

  // 현재 조준 방향(단위 벡터, forward/lateral 성분). 핀 정조준 + aim 회전.
  aimDirection() {
    const dirF = this.hole.total - this.hole.forward;
    const dirL = -this.hole.lateral;               // 핀(중심선)을 향함
    const len = Math.max(1, Math.hypot(dirF, dirL));
    const nf = dirF / len, nl = dirL / len;
    const th = this.aim * Math.PI / 180;
    const c = Math.cos(th), s = Math.sin(th);
    return { nf: nf * c - nl * s, nl: nf * s + nl * c };
  }

  selectCourse(id, numPlayers = 1, names = []) {
    const c = COURSES.find((x) => x.id === id);
    if (!c) return;
    this.course = c;
    this.holeIndex = 0;
    this.activeIdx = 0;
    const n = clamp(numPlayers | 0, 1, 4);
    this.players = [];
    for (let i = 0; i < n; i++) {
      const nm = (names[i] && String(names[i]).trim()) ? String(names[i]).trim().slice(0, 10) : `P${i + 1}`;
      this.players.push({ name: nm, color: PLAYER_COLORS[i], holes: [] });
    }
    this.lastShotYards = 0;
    this._newHole();
    const who = n > 1 ? ` · ${n}인 플레이` : '';
    this.onMessage(`${c.name} · ${c.difficulty} · ${c.holes.length}홀${who} 시작!`, true);
  }

  // 새 홀 : 지형/바람 새로 생성(모든 플레이어가 같은 조건). 첫 플레이어 티로.
  _newHole() {
    const wm = this.course.windMax;
    this.wind = {
      cross: (Math.random() * 2 - 1) * wm,
      head: (Math.random() * 2 - 1) * wm * 0.6,
    };
    this._resetBall();                  // this.hole 설정
    this.scenery = this._makeScenery(); // this.hole.total 사용
    this._notify();
    this.onHoleReady();
  }

  // 공만 티로 리셋(지형/바람 유지) — 플레이어 교체 시 사용
  _resetBall() {
    const h = this.course.holes[this.holeIndex];
    this.hole = {
      par: h.par, total: h.total, name: `${this.holeIndex + 1}번 홀`,
      forward: 0, lateral: 0, strokes: 0, holed: false,
      bendDeg: h.bendDeg || 0,
    };
    this._buildPath();
    this.flight = null;
    this.aim = 0;
    this.club = CLUBS.driver;
    this._notify();
  }

  // -------------------------------------------------------------------------
  // 코스 중심선(도그렉) : 물리는 직선(forward/lateral) 그대로 두고,
  // 렌더링에서 (forward,lateral)를 휘어진 월드 경로로 매핑한다.
  // -------------------------------------------------------------------------
  _buildPath() {
    const total = this.hole.total;
    const bend = (this.hole.bendDeg || 0) * Math.PI / 180;   // 총 방향 전환
    const s0 = 0.34 * total, s1 = 0.74 * total;              // 휘는 구간
    const step = 4;
    let x = 0, z = 0;
    const pts = [{ f: 0, x: 0, z: 0, hx: 0, hz: -1 }];
    for (let f = step; f <= total + 60; f += step) {
      const th = bend * smoothstep(s0, s1, f);
      const hx = Math.sin(th), hz = -Math.cos(th);           // 진행 방향 단위벡터
      x += hx * step; z += hz * step;
      pts.push({ f, x, z, hx, hz });
    }
    this.path = pts;
    this.pathStep = step;
  }

  // forward(경로 길이) → 경로 위 점 + 진행 방향
  pathPoint(f) {
    const p = this.path;
    if (!p) return { x: 0, z: -f, hx: 0, hz: -1 };
    let i = Math.floor(f / this.pathStep);
    i = clamp(i, 0, p.length - 2);
    const a = p[i], b = p[i + 1];
    const t = clamp((f - a.f) / (b.f - a.f || 1), 0, 1);
    let hx = lerp(a.hx, b.hx, t), hz = lerp(a.hz, b.hz, t);
    const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), hx, hz };
  }

  // 스트립 좌표(forward, lateral) → 월드 좌표(x,z) + 진행 방향
  worldOf(f, l) {
    const p = this.pathPoint(f);
    const nx = -p.hz, nz = p.hx;          // 오른쪽 법선(+lateral = 오른쪽)
    return { x: p.x + nx * l, z: p.z + nz * l, hx: p.hx, hz: p.hz };
  }

  // 월드 좌표 → 가장 가까운 스트립 좌표(forward, lateral) : 지형 색칠용
  nearestOnPath(wx, wz) {
    const p = this.path;
    if (!p) return { f: -wz, l: wx };
    let bi = 0, bd = Infinity;
    for (let i = 0; i < p.length; i++) {
      const dx = wx - p[i].x, dz = wz - p[i].z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    const a = p[bi];
    const dx = wx - a.x, dz = wz - a.z;
    const l = dx * (-a.hz) + dz * (a.hx);   // 오른쪽 법선 성분
    const along = dx * a.hx + dz * a.hz;    // 진행 방향 성분(f 보정)
    return { f: a.f + along, l };
  }

  // 홀아웃 후 진행 : 다음 플레이어 → 다음 홀 → 코스 완주
  advance() {
    if (this.activeIdx + 1 < this.players.length) {
      this.activeIdx++;
      this._resetBall();                // 같은 홀, 지형/바람 유지
      this.onTurn();
      this.onMessage(`${this.activeName()} 차례 — ${this.hole.name}`, true);
      return;
    }
    if (this.holeIndex >= this.course.holes.length - 1) {
      this.onCourseComplete(this.scoreboard(), this.course);
      return;
    }
    this.holeIndex++;
    this.activeIdx = 0;
    this._newHole();
    this.onTurn();
    this.onMessage(`${this.hole.name} · 파 ${this.hole.par} · ${this.hole.total}yd`);
  }

  scoreboard() {
    return this.players.map((p) => ({
      name: p.name, color: p.color,
      total: p.holes.reduce((a, b) => a + (b || 0), 0),
      holes: p.holes.slice(),
    }));
  }

  setClub(key) {
    if (!CLUBS[key]) return;
    if (this.flight) return;
    this.club = CLUBS[key];
    this._notify();
  }

  get remaining() {
    const dx = this.hole.total - this.hole.forward;
    const dy = this.hole.lateral;
    return Math.sqrt(dx * dx + dy * dy);
  }
  get onGreen() { return this.remaining <= 30; }

  recommendClub() {
    const r = this.remaining;
    if (r <= 25) return 'putter';
    if (r <= 175) return 'iron';
    return 'driver';
  }

  isBusy() { return !!this.flight || this.hole.holed; }

  // -------------------------------------------------------------------------
  // 샷 : power 0~100, accuracy -1(좌)~+1(우)
  // -------------------------------------------------------------------------
  hit(power, accuracy) {
    if (this.isBusy()) return;
    power = clamp(power, 0, 100);
    accuracy = clamp(accuracy, -1, 1);

    const club = this.club;
    // 비거리 : 퍼터는 그린 위에서 '남은 거리'에 비례(조준 잘하면 홀인),
    //          그린 밖 퍼터는 약하게. 나머지 클럽은 최대비거리 × 파워.
    let carry;
    if (club.key === 'putter') {
      const base = this.onGreen ? Math.max(this.remaining * (this.course.greenSpeed || 1.12), 4) : 18;
      carry = base * (power / 100);
    } else {
      carry = club.maxYards * (power / 100);
    }

    let side = accuracy * club.sideMax * (power / 100) / this.course.forgive;
    if (club.key !== 'putter') {
      const travel = carry / 240;
      carry = Math.max(3, carry - this.wind.head * travel);
      side += this.wind.cross * travel;
    }

    // 진행 방향 : 핀 정조준 + 조준각(aim). 좌우 오차는 수직 성분.
    const d = this.aimDirection();
    const nx = d.nf, ny = d.nl;
    const px = -ny, py = nx;
    const start = { f: this.hole.forward, l: this.hole.lateral };
    const end = {
      f: this.hole.forward + nx * carry + px * side,
      l: this.hole.lateral + ny * carry + py * side,
    };

    this.hole.strokes++;
    this.lastShotYards = Math.round(carry);
    this.onShot({ carry: this.lastShotYards, club: club.name, power: Math.round(power) });

    let judge;
    if (Math.abs(accuracy) < 0.12) judge = 'GREAT SHOT! 👍';
    else if (Math.abs(accuracy) < 0.35) judge = 'GOOD SHOT';
    else judge = accuracy < 0 ? '왼쪽으로 밀림 ↙' : '오른쪽으로 밀림 ↘';

    const airTime = Math.min(2400, 800 + carry * 4.5);
    this.flight = {
      t0: performance.now(), dur: airTime,
      start, end, apex: club.loft / 45, carry, side, judge, power,
    };
    this.aim = 0;   // 다음 샷은 다시 핀 정조준부터
    this.onMessage(`${judge} · ${this.lastShotYards}yd`, true);
  }

  _land() {
    const fl = this.flight;
    this.hole.forward = fl.end.f;
    this.hole.lateral = fl.end.l;
    this.flight = null;

    // 워터 해저드
    for (const p of this.scenery.ponds) {
      const df = (this.hole.forward - p.f) / p.rf;
      const dl = (this.hole.lateral - p.l) / p.rl;
      if (df * df + dl * dl <= 1) {
        this.hole.strokes++;
        this.hole.forward = fl.start.f;
        this.hole.lateral = fl.start.l;
        this.onMessage('💦 워터 해저드! +1 벌타', true);
        this.onWater();
        this.setClub(this.recommendClub());
        this._notify();
        return;
      }
    }

    const rem = this.remaining;
    const holeRadius = (this.club.key === 'putter' ? 2.6 : 2.4) * (this.course.cupMul || 1);
    if (rem <= holeRadius) {
      this.hole.holed = true;
      // 이 플레이어의 이 홀 성적 기록
      this.players[this.activeIdx].holes[this.holeIndex] = this.hole.strokes;
      const diff = this.hole.strokes - this.hole.par;
      const term = diff <= -2 ? '이글!! 🦅' : diff === -1 ? '버디! 🐦' :
                   diff === 0 ? '파(PAR)' : diff === 1 ? '보기' : `+${diff} 오버`;
      const isFinal = this.holeIndex >= this.course.holes.length - 1
                   && this.activeIdx >= this.players.length - 1;
      const who = this.numPlayers > 1 ? `${this.activeName()} · ` : '';
      this.onMessage(`🏌 ${who}홀 아웃 — ${this.hole.strokes}타 · ${term}`, true);
      this.onHoled(this.hole.strokes, this.hole.par, isFinal);
    } else {
      const rec = this.recommendClub();
      this.setClub(rec);
      this.onLand();
      this.onMessage(`남은 거리 ${Math.round(rem)}yd — ${CLUBS[rec].name} 추천`);
    }
    this._notify();
  }

  _notify() {
    const speed = Math.hypot(this.wind.cross, this.wind.head);
    this.onState({
      course: this.course.name, difficulty: this.course.difficulty, stars: this.course.stars,
      hole: this.hole.name, holeNum: this.holeIndex + 1, holeCount: this.course.holes.length,
      par: this.hole.par, strokes: this.hole.strokes, remaining: Math.round(this.remaining),
      club: this.club.key, onGreen: this.onGreen, recommend: this.recommendClub(),
      wind: { cross: this.wind.cross, head: this.wind.head, speed: Math.round(speed) },
      lastShotYards: this.lastShotYards,
      aim: Math.round(this.aim),
      activeName: this.activeName(),
      players: this.players.map((p, i) => ({
        name: p.name, color: p.color,
        total: p.holes.reduce((a, b) => a + (b || 0), 0),
        holeStrokes: i < this.activeIdx ? (p.holes[this.holeIndex] ?? null)
                   : i === this.activeIdx ? this.hole.strokes : null,
        active: i === this.activeIdx,
        done: i < this.activeIdx,
      })),
    });
  }

  // 비행 종료 판정(3D 렌더는 scene3d 가 담당, 여기선 상태만 진행)
  update(now) {
    if (this.flight && now - this.flight.t0 >= this.flight.dur) this._land();
  }

  // 홀별 조경(야자수·연못·벙커) 생성 — 난이도가 높을수록 촘촘·많이·가깝게
  _makeScenery() {
    const total = this.hole.total;
    const rng = Math.random;
    const hard = this.course.stars >= 3;
    const trees = [];
    const edge = hard ? 25 : 30;                 // 고급: 나무가 페어웨이에 더 가까움
    const stepBase = hard ? 18 : 24;             // 고급: 더 촘촘
    const skip = hard ? 0.10 : 0.22;
    for (let f = 30; f < total - 8; f += stepBase + rng() * 16) {
      for (const side of [-1, 1]) {
        if (rng() < skip) continue;
        const l = side * (edge + 3 + rng() * (hard ? 16 : 22));
        trees.push({ f, l, size: 0.85 + rng() * 0.8, kind: 'palm' });
      }
    }
    // 워터 해저드 : 고급은 착지 지점까지 3개
    const ponds = [];
    const n = hard ? 3 : this.course.stars === 2 ? 1 : (rng() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const f = hard
        ? total * (0.34 + i * 0.22) + (rng() * 0.06 - 0.03) * total
        : total * (0.5 + i * 0.26 + (rng() * 0.1 - 0.05));
      const l = (rng() * 2 - 1) * (hard ? 26 : 22);
      ponds.push({ f, l, rl: (hard ? 20 : 16) + rng() * 14, rf: (hard ? 26 : 20) + rng() * 16 });
    }
    // 모래 벙커 : 그린 주변 + 고급은 페어웨이 지뢰밭
    const bunkers = [
      { f: total - 22, l: -18, r: 8 },
      { f: total - 18, l: 20, r: 7 },
    ];
    if (hard) {
      bunkers.push({ f: total * 0.46, l: -24, r: 10 });
      bunkers.push({ f: total * 0.66, l: 26, r: 9 });
    } else if (total > 340) {
      bunkers.push({ f: total * 0.56, l: (rng() < 0.5 ? -1 : 1) * 30, r: 9 });
    }
    return { trees, ponds, bunkers };
  }

  // -------------------------------------------------------------------------
  // 미니맵 : 실제 홀 코스 지도 (러프·페어웨이·그린·해저드·나무·거리눈금)
  // -------------------------------------------------------------------------
  renderMini() {
    const ctx = this.mctx;
    const W = this.mini.width, H = this.mini.height;
    ctx.clearRect(0, 0, W, H);

    // 경로(월드) 기준으로 자동 맞춤 → 휜 코스가 그대로 보임
    const p = this.path || [{ x: 0, z: 0 }, { x: 0, z: -this.hole.total }];
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (const q of p) { minx = Math.min(minx, q.x); maxx = Math.max(maxx, q.x); minz = Math.min(minz, q.z); maxz = Math.max(maxz, q.z); }
    minx -= 45; maxx += 45; minz -= 20; maxz += 20;
    const pad = 12;
    const s = Math.min((W - pad * 2) / (maxx - minx), (H - pad * 2) / (maxz - minz));
    const ox = pad + (W - pad * 2 - (maxx - minx) * s) / 2;
    const oy = pad + (H - pad * 2 - (maxz - minz) * s) / 2;
    const X = (wx) => ox + (wx - minx) * s;
    const Y = (wz) => oy + (wz - minz) * s;   // z 작을수록(그린) 위
    const wpt = (f, l) => { const w = this.worldOf(f, l); return [X(w.x), Y(w.z)]; };

    // 러프 배경
    ctx.fillStyle = '#3c7a3e';
    roundRect(ctx, 0, 0, W, H, 10); ctx.fill();
    ctx.save(); roundRect(ctx, 0, 0, W, H, 10); ctx.clip();

    // 페어웨이 : 중심선을 따라 굵은 곡선
    ctx.strokeStyle = '#57b552';
    ctx.lineWidth = Math.max(6, 48 * s);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < p.length; i += 2) { const q = p[i]; i === 0 ? ctx.moveTo(X(q.x), Y(q.z)) : ctx.lineTo(X(q.x), Y(q.z)); }
    ctx.stroke();

    // 벙커
    for (const b of (this.scenery.bunkers || [])) {
      const [bx2, by2] = wpt(b.f, b.l);
      ctx.fillStyle = '#eddcb0';
      ctx.beginPath(); ctx.ellipse(bx2, by2, Math.max(3, b.r * s), Math.max(2, b.r * s * 0.7), 0, 0, Math.PI * 2); ctx.fill();
    }
    // 야자수
    ctx.fillStyle = '#276b34';
    for (const t of this.scenery.trees) { const [tx, ty] = wpt(t.f, t.l); ctx.beginPath(); ctx.arc(tx, ty, 2.2, 0, Math.PI * 2); ctx.fill(); }
    // 연못
    for (const pd of this.scenery.ponds) {
      const [px2, py2] = wpt(pd.f, pd.l);
      ctx.fillStyle = '#3b93cf';
      ctx.beginPath(); ctx.ellipse(px2, py2, Math.max(4, pd.rl * s), Math.max(3, pd.rf * s * 0.6), 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.stroke();
    }

    // 그린 + 홀컵 + 깃발
    const [gx, gy] = wpt(this.hole.total, 0);
    ctx.fillStyle = '#bff0a6';
    ctx.beginPath(); ctx.arc(gx, gy, Math.max(6, 17 * s), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(gx, gy, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx, gy - 10); ctx.stroke();
    ctx.fillStyle = '#e63946';
    ctx.beginPath(); ctx.moveTo(gx, gy - 10); ctx.lineTo(gx + 6, gy - 8); ctx.lineTo(gx, gy - 6); ctx.fill();

    // 티
    const [tx0, ty0] = wpt(0, 0);
    ctx.fillStyle = '#4c9e50';
    roundRect(ctx, tx0 - 6, ty0 - 3, 12, 7, 3); ctx.fill();

    // 조준선(노랑) — 스트립 조준을 월드로
    const [bx, by] = wpt(this.hole.forward, this.hole.lateral);
    const d = this.aimDirection();
    const aw = this.worldOf(this.hole.forward, this.hole.lateral);
    const nx = -aw.hz, nz = aw.hx;
    const wdx = aw.hx * d.nf + nx * d.nl, wdz = aw.hz * d.nf + nz * d.nl;
    ctx.strokeStyle = 'rgba(255,212,59,0.95)';
    ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(X(aw.x + wdx * 70), Y(aw.z + wdz * 70)); ctx.stroke();
    ctx.setLineDash([]);

    // 공(현재 플레이어 색)
    ctx.fillStyle = this.activeColor();
    ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();

    ctx.restore();

    // 남은거리 라벨
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, W / 2 - 26, 3, 52, 15, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(this.remaining)}yd`, W / 2, 14);
  }
}

// helpers
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
