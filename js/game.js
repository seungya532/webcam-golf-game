// game.js
// 골프 물리 모델 + 1인칭(2.5D) 필드 렌더링 + 미니맵
// 외부 라이브러리 0. 순수 Canvas 2D.

// ---------------------------------------------------------------------------
// 클럽 정의 : 최대 비거리(yd), 로프트(발사각), 좌우 오차 상한(yd)
// ---------------------------------------------------------------------------
export const CLUBS = {
  driver: { key: 'driver', name: '드라이버', maxYards: 260, loft: 12, sideMax: 34, color: '#ff7a45' },
  iron:   { key: 'iron',   name: '아이언',   maxYards: 165, loft: 26, sideMax: 20, color: '#4dabf7' },
  putter: { key: 'putter', name: '퍼터',     maxYards: 18,  loft: 2,  sideMax: 4,  color: '#20c997' },
};

// 코스(홀) 정의
const HOLES = [
  { par: 4, total: 380, name: '1번 홀' },
  { par: 3, total: 175, name: '2번 홀' },
  { par: 5, total: 505, name: '3번 홀' },
];

export class GolfGame {
  constructor(fieldCanvas, miniCanvas) {
    this.field = fieldCanvas;
    this.fctx = fieldCanvas.getContext('2d');
    this.mini = miniCanvas;
    this.mctx = miniCanvas.getContext('2d');

    this.holeIndex = 0;
    this.club = CLUBS.driver;

    // 이벤트 콜백 (main.js 에서 주입)
    this.onMessage = () => {};
    this.onState = () => {};   // 홀/스코어 등 UI 갱신
    this.onHoled = () => {};

    // 비행 애니메이션 상태
    this.flight = null;

    // 마지막 샷 결과 텍스트
    this.lastResult = '';

    this._resetHole();
  }

  // -------------------------------------------------------------------------
  // 홀 상태 초기화
  // -------------------------------------------------------------------------
  _resetHole() {
    const h = HOLES[this.holeIndex];
    this.hole = {
      par: h.par,
      total: h.total,     // 티에서 홀컵까지 전장(yd)
      name: h.name,
      forward: 0,         // 티 기준 전진 거리(yd)
      lateral: 0,         // 중심선 기준 좌(-)/우(+) 이탈(yd)
      strokes: 0,
      holed: false,
    };
    this.flight = null;
    this.lastResult = '';
    // 첫 샷은 드라이버 추천
    this.club = CLUBS.driver;
    this._notify();
  }

  nextHole() {
    this.holeIndex = (this.holeIndex + 1) % HOLES.length;
    this._resetHole();
    this.onMessage(`${this.hole.name} · 파 ${this.hole.par} · ${this.hole.total}yd`);
  }

  setClub(key) {
    if (!CLUBS[key]) return;
    if (this.flight) return;           // 비행 중 교체 금지
    this.club = CLUBS[key];
    this._notify();
  }

  // 홀컵까지 남은 직선 거리(yd)
  get remaining() {
    const dx = this.hole.total - this.hole.forward;
    const dy = this.hole.lateral;
    return Math.sqrt(dx * dx + dy * dy);
  }

  get onGreen() {
    return this.remaining <= 30;
  }

  // 남은 거리에 맞는 추천 클럽
  recommendClub() {
    const r = this.remaining;
    if (r <= 25) return 'putter';
    if (r <= 175) return 'iron';
    return 'driver';
  }

  isBusy() {
    return !!this.flight || this.hole.holed;
  }

  // -------------------------------------------------------------------------
  // 샷 실행 : power 0~100, accuracy -1(좌)~+1(우), 0 = 완벽
  // -------------------------------------------------------------------------
  hit(power, accuracy) {
    if (this.isBusy()) return;
    power = clamp(power, 0, 100);
    accuracy = clamp(accuracy, -1, 1);

    const club = this.club;
    // 캐리 거리
    let carry = club.maxYards * (power / 100);
    // 퍼터는 그린 밖에서 힘이 크게 줄도록(현실감)
    if (club.key === 'putter' && !this.onGreen) carry *= 0.6;

    // 좌우 이탈
    const side = accuracy * club.sideMax * (power / 100);

    // 목표 지점(홀컵)을 향하는 방향으로 전진 + 좌우 오차
    const before = this.remaining;
    const dirX = (this.hole.total - this.hole.forward);
    const dirY = this.hole.lateral;
    const dirLen = Math.max(1, Math.sqrt(dirX * dirX + dirY * dirY));
    const nx = dirX / dirLen, ny = dirY / dirLen;
    // 전진 성분 + 수직(좌우) 성분
    const px = -ny, py = nx; // 진행방향에 수직인 단위벡터
    const start = { f: this.hole.forward, l: this.hole.lateral };
    const end = {
      f: this.hole.forward + nx * carry + px * side,
      l: this.hole.lateral + ny * carry + py * side,
    };

    this.hole.strokes++;

    // 판정 텍스트
    let judge = 'NICE SHOT';
    if (Math.abs(accuracy) < 0.12) judge = 'GREAT SHOT! 👍';
    else if (Math.abs(accuracy) < 0.35) judge = 'GOOD SHOT';
    else judge = accuracy < 0 ? '왼쪽으로 밀림 ↙' : '오른쪽으로 밀림 ↘';

    // 비행 애니메이션 세팅
    const loftT = club.loft / 45;           // 로프트 → 아크 높이 비율
    const airTime = Math.min(2200, 700 + carry * 4); // ms
    this.flight = {
      t0: performance.now(),
      dur: airTime,
      start, end,
      apex: loftT,      // 최대 높이 비율(화면 연출용)
      carry,
      side,             // 좌우 이탈(yd) — 화면 드리프트 연출
      judge,
      power,
    };
    this.lastResult = `${club.name} · 파워 ${Math.round(power)} · 비거리 ${Math.round(carry)}yd`;
    this.onMessage(judge, true);
  }

  // 비행 애니메이션이 끝났을 때 착지 처리
  _land() {
    const fl = this.flight;
    this.hole.forward = fl.end.f;
    this.hole.lateral = fl.end.l;
    this.flight = null;

    const rem = this.remaining;
    // 홀인 판정
    const holeRadius = this.club.key === 'putter' ? 1.6 : 2.4;
    if (rem <= holeRadius) {
      this.hole.holed = true;
      const diff = this.hole.strokes - this.hole.par;
      let term = diff === 0 ? '파(PAR)' :
                 diff === -1 ? '버디! 🐦' :
                 diff <= -2 ? '이글!! 🦅' :
                 diff === 1 ? '보기' : `+${diff} 오버`;
      this.onMessage(`🏌 홀 아웃 — ${this.hole.strokes}타 · ${term}`, true);
      this.onHoled(this.hole.strokes, this.hole.par);
    } else {
      // 다음 클럽 자동 추천
      const rec = this.recommendClub();
      this.setClub(rec);
      this.onMessage(`남은 거리 ${Math.round(rem)}yd — ${CLUBS[rec].name} 추천`);
    }
    this._notify();
  }

  _notify() {
    this.onState({
      hole: this.hole.name,
      par: this.hole.par,
      strokes: this.hole.strokes,
      remaining: Math.round(this.remaining),
      club: this.club.key,
      onGreen: this.onGreen,
      recommend: this.recommendClub(),
    });
  }

  // -------------------------------------------------------------------------
  // 렌더링 : 매 프레임 호출
  // -------------------------------------------------------------------------
  render(now) {
    this._renderField(now);
    this._renderMini();
    // 비행 종료 체크
    if (this.flight && now - this.flight.t0 >= this.flight.dur) {
      this._land();
    }
  }

  _renderField(now) {
    const ctx = this.fctx;
    const W = this.field.width, H = this.field.height;
    const horizon = H * 0.42;

    // --- 하늘 ---
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#5bb8f0');
    sky.addColorStop(1, '#d9f0ff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, horizon);

    // 태양
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#fff6cc';
    ctx.beginPath();
    ctx.arc(W * 0.78, horizon * 0.42, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 먼 언덕
    ctx.fillStyle = '#8fd694';
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.quadraticCurveTo(W * 0.25, horizon - 34, W * 0.5, horizon - 6);
    ctx.quadraticCurveTo(W * 0.75, horizon - 40, W, horizon - 10);
    ctx.lineTo(W, horizon);
    ctx.closePath();
    ctx.fill();

    // --- 페어웨이(원근 사다리꼴) ---
    const grad = ctx.createLinearGradient(0, horizon, 0, H);
    grad.addColorStop(0, '#3f9e4d');
    grad.addColorStop(1, '#6fce6a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, horizon, W, H - horizon);

    // 페어웨이 밝은 중앙 통로 + 잔디 줄무늬(원근 수렴)
    const cx = W / 2 - this.hole.lateral * 1.3; // 좌우 이탈만큼 시점 이동
    const topW = W * 0.10, botW = W * 1.05;
    ctx.fillStyle = '#5cbb57';
    ctx.beginPath();
    ctx.moveTo(cx - topW / 2, horizon);
    ctx.lineTo(cx + topW / 2, horizon);
    ctx.lineTo(cx + botW / 2, H);
    ctx.lineTo(cx - botW / 2, H);
    ctx.closePath();
    ctx.fill();

    // 잔디 줄무늬
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - topW / 2, horizon);
    ctx.lineTo(cx + topW / 2, horizon);
    ctx.lineTo(cx + botW / 2, H);
    ctx.lineTo(cx - botW / 2, H);
    ctx.closePath();
    ctx.clip();
    for (let i = 0; i < 9; i++) {
      const d = i / 9;
      const y = horizon + (H - horizon) * (d * d); // 원근 가속
      const h = (H - horizon) * (((i + 1) / 9) ** 2 - d * d);
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
      ctx.fillRect(0, y, W, h);
    }
    ctx.restore();

    // --- 홀컵/깃발 : 카메라(공)로부터 남은 거리에 따라 원근 배치 ---
    this._renderPin(ctx, W, H, horizon);

    // --- 공 / 비행 ---
    this._renderBall(ctx, W, H, horizon, cx, now);
  }

  _renderPin(ctx, W, H, horizon) {
    const rem = this.remaining;
    // 카메라는 항상 홀을 바라본다 → 핀은 화면 중앙, 거리로 원근.
    const depth = depthFromDist(rem);
    const flagX = W / 2;
    const flagY = screenY(depth, horizon, H);
    const s = 0.3 + (1 - depth) * 1.5;

    // 그린(홀 근처 밝은 원)
    if (rem < 90) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#a7e89a';
      ctx.beginPath();
      ctx.ellipse(flagX, flagY + 6 * s, 46 * s, 16 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 홀컵
    ctx.fillStyle = '#1f1f1f';
    ctx.beginPath();
    ctx.ellipse(flagX, flagY, 7 * s, 3 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // 깃대 + 깃발
    const poleH = 60 * s;
    ctx.strokeStyle = '#eee';
    ctx.lineWidth = Math.max(1, 2 * s);
    ctx.beginPath();
    ctx.moveTo(flagX, flagY);
    ctx.lineTo(flagX, flagY - poleH);
    ctx.stroke();
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(flagX, flagY - poleH);
    ctx.lineTo(flagX + 22 * s, flagY - poleH + 8 * s);
    ctx.lineTo(flagX, flagY - poleH + 16 * s);
    ctx.closePath();
    ctx.fill();

    // 남은 거리 라벨
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.font = `${Math.round(11 + 6 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(rem)}yd`, flagX, flagY - poleH - 6);
  }

  _renderBall(ctx, W, H, horizon, cx, now) {
    let bx, by, r, shadowY;
    if (this.flight) {
      const fl = this.flight;
      const p = clamp((now - fl.t0) / fl.dur, 0, 1);
      // 카메라(티)로부터 이동 거리 → 깊이
      const dist = fl.carry * p;
      const depth = depthFromDist(dist);
      by = screenY(depth, horizon, H);
      // 좌우 이탈 : 진행할수록 벌어지고 원근으로 압축
      bx = W / 2 + fl.side * 4 * p * (1 - depth * 0.4);
      // 포물선 로프트(위로 뜸)
      const arc = Math.sin(p * Math.PI) * fl.apex * (H * 0.42);
      shadowY = by;
      by -= arc;
      r = clamp(15 * (1 - depth) + 2.5, 2.5, 15);
    } else if (!this.hole.holed) {
      // 어드레스 : 발밑(공을 내려다보는 시점) — 하단 바에 가리지 않게
      bx = cx;
      by = H * 0.8;
      shadowY = by;
      r = 16;
    } else {
      return; // 홀아웃 후 공 숨김
    }

    // 그림자
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(bx, shadowY + 2, r * 1.1, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 공
    const g = ctx.createRadialGradient(bx - r * 0.3, by - r * 0.3, r * 0.2, bx, by, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#c8d0d6');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // -------------------------------------------------------------------------
  // 미니맵(탑다운)
  // -------------------------------------------------------------------------
  _renderMini() {
    const ctx = this.mctx;
    const W = this.mini.width, H = this.mini.height;
    ctx.clearRect(0, 0, W, H);

    // 배경
    ctx.fillStyle = '#2f6b34';
    roundRect(ctx, 0, 0, W, H, 10);
    ctx.fill();

    const pad = 16;
    const total = this.hole.total;
    // 세로: 아래(티) → 위(홀컵)
    const y = (f) => H - pad - (f / total) * (H - pad * 2);
    const x = (l) => W / 2 + (l / (total * 0.18)) * (W / 2 - pad);

    // 페어웨이 라인
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2, y(0));
    ctx.lineTo(W / 2, y(total));
    ctx.stroke();
    ctx.setLineDash([]);

    // 그린 원
    ctx.fillStyle = 'rgba(167,232,154,0.6)';
    ctx.beginPath();
    ctx.arc(W / 2, y(total), 14, 0, Math.PI * 2);
    ctx.fill();

    // 홀컵
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(W / 2, y(total), 3.5, 0, Math.PI * 2);
    ctx.fill();
    // 깃발
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2, y(total)); ctx.lineTo(W / 2, y(total) - 10); ctx.stroke();
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(W / 2, y(total) - 10);
    ctx.lineTo(W / 2 + 7, y(total) - 7);
    ctx.lineTo(W / 2, y(total) - 4);
    ctx.fill();

    // 티
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(W / 2, y(0), 3, 0, Math.PI * 2); ctx.fill();

    // 공 현재 위치
    const bx = clamp(x(this.hole.lateral), pad, W - pad);
    const by = clamp(y(this.hole.forward), pad, H - pad);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(bx, by, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();

    // 남은거리 텍스트
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(this.remaining)}yd`, W / 2, 14);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

// 시야 : 이 거리(yd)면 지평선에 닿는다
const VIEW = 300;
// 카메라(공 위치)로부터 거리 d(yd) → 깊이 0(발밑)~0.985(지평선)
function depthFromDist(d) { return clamp(d / VIEW, 0, 0.985); }
// 깊이 → 화면 y : depth 0 → 화면 하단, depth 1 → 지평선
function screenY(depth, horizon, H) {
  return horizon + (H - horizon) * Math.pow(1 - depth, 1.7);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
