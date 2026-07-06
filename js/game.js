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
    desc: '정직한 거리와 약한 바람의 표준 코스.',
    windMax: 7, forgive: 1.0,
    holes: [ { par: 4, total: 380 }, { par: 3, total: 190 }, { par: 5, total: 505 }, { par: 4, total: 410 } ],
  },
  {
    id: 'championship', name: '챔피언십 링크스', difficulty: '고급', stars: 3,
    desc: '긴 홀·강한 바람·좁은 페어웨이. 상급자 도전용.',
    windMax: 15, forgive: 0.7,
    holes: [ { par: 5, total: 560 }, { par: 4, total: 445 }, { par: 3, total: 225 }, { par: 4, total: 470 }, { par: 5, total: 590 } ],
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
    this.onTurn = () => {};

    this.flight = null;
    this.lastShotYards = 0;
    this.wind = { cross: 0, head: 0 };
    this.scenery = { trees: [], ponds: [] };
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

  selectCourse(id, numPlayers = 1) {
    const c = COURSES.find((x) => x.id === id);
    if (!c) return;
    this.course = c;
    this.holeIndex = 0;
    this.activeIdx = 0;
    const n = clamp(numPlayers | 0, 1, 4);
    this.players = [];
    for (let i = 0; i < n; i++) this.players.push({ name: `P${i + 1}`, color: PLAYER_COLORS[i], holes: [] });
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
    };
    this.flight = null;
    this.aim = 0;
    this.club = CLUBS.driver;
    this._notify();
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
      const base = this.onGreen ? Math.max(this.remaining * 1.12, 4) : 18;
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
    const holeRadius = this.club.key === 'putter' ? 2.6 : 2.4;
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

  // 홀별 조경(나무·연못) 생성
  _makeScenery() {
    const total = this.hole.total;
    const rng = Math.random;
    const trees = [];
    const edge = 26;
    for (let f = 34; f < total - 8; f += 26 + rng() * 22) {
      for (const side of [-1, 1]) {
        if (rng() < 0.25) continue;
        const l = side * (edge + 6 + rng() * 26);
        trees.push({ f, l, size: 0.8 + rng() * 0.8, kind: rng() < 0.5 ? 'pine' : 'round' });
      }
    }
    const ponds = [];
    const n = this.course.stars >= 3 ? 2 : this.course.stars === 2 ? 1 : (rng() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const f = total * (0.5 + i * 0.26 + (rng() * 0.1 - 0.05));
      const l = (rng() * 2 - 1) * 22;
      ponds.push({ f, l, rl: 16 + rng() * 14, rf: 20 + rng() * 16 });
    }
    return { trees, ponds };
  }

  // -------------------------------------------------------------------------
  // 미니맵 : 실제 홀 코스 지도 (러프·페어웨이·그린·해저드·나무·거리눈금)
  // -------------------------------------------------------------------------
  renderMini() {
    const ctx = this.mctx;
    const W = this.mini.width, H = this.mini.height;
    ctx.clearRect(0, 0, W, H);

    const pad = 14;
    const total = this.hole.total;
    const half = total * 0.18;                       // 좌우 표시 범위(yd)
    const y = (f) => H - pad - (f / total) * (H - pad * 2);
    const x = (l) => W / 2 + (l / half) * (W / 2 - pad);
    const xw = (yd) => (yd / half) * (W / 2 - pad);  // yd → px 폭

    // 러프 배경
    ctx.fillStyle = '#3c7a3e';
    roundRect(ctx, 0, 0, W, H, 10); ctx.fill();
    ctx.save(); roundRect(ctx, 0, 0, W, H, 10); ctx.clip();

    // 페어웨이 코리도(밝은 초록, 둥근 끝)
    const fwHalf = xw(24);
    ctx.fillStyle = '#57b552';
    roundRect(ctx, W / 2 - fwHalf, y(total) - 4, fwHalf * 2, (y(0) - y(total)) + 8, fwHalf);
    ctx.fill();

    // 거리 눈금(100yd)
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '8px system-ui, sans-serif'; ctx.textAlign = 'left';
    for (let m = 100; m < total; m += 100) {
      ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(W / 2 - fwHalf, y(m)); ctx.lineTo(W / 2 + fwHalf, y(m)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(String(m), W / 2 + fwHalf + 2, y(m) + 3);
    }

    // 나무(작은 점)
    ctx.fillStyle = '#276b34';
    for (const t of this.scenery.trees) {
      ctx.beginPath(); ctx.arc(clamp(x(t.l), 3, W - 3), y(t.f), 2.3, 0, Math.PI * 2); ctx.fill();
    }
    // 연못(해저드)
    for (const p of this.scenery.ponds) {
      ctx.fillStyle = '#3b93cf';
      ctx.beginPath();
      ctx.ellipse(clamp(x(p.l), pad, W - pad), y(p.f), Math.max(4, xw(p.rl)), Math.max(3, xw(p.rf) * 0.5), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.stroke();
    }

    // 그린
    ctx.fillStyle = '#bff0a6';
    ctx.beginPath(); ctx.arc(W / 2, y(total), xw(17), 0, Math.PI * 2); ctx.fill();
    // 홀컵 + 깃발
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(W / 2, y(total), 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2, y(total)); ctx.lineTo(W / 2, y(total) - 11); ctx.stroke();
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(W / 2, y(total) - 11); ctx.lineTo(W / 2 + 7, y(total) - 8); ctx.lineTo(W / 2, y(total) - 5);
    ctx.fill();

    // 티 박스
    ctx.fillStyle = '#4c9e50';
    roundRect(ctx, W / 2 - 7, y(0) - 3, 14, 8, 3); ctx.fill();

    // 조준선(노랑)
    const bx = clamp(x(this.hole.lateral), pad, W - pad);
    const by = clamp(y(this.hole.forward), pad, H - pad);
    const d = this.aimDirection();
    const ax = x(this.hole.lateral + d.nl * total * 0.3);
    const ay = y(this.hole.forward + d.nf * total * 0.3);
    ctx.strokeStyle = 'rgba(255,212,59,0.95)';
    ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ax, ay); ctx.stroke();
    ctx.setLineDash([]);

    // 공(현재 플레이어 색)
    ctx.fillStyle = this.activeColor();
    ctx.beginPath(); ctx.arc(bx, by, 4.2, 0, Math.PI * 2); ctx.fill();
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
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
