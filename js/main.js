// main.js
// 전체 연결 : 게임 루프 · 3D 씬 · 웹캠(포즈)/키보드 모드 · UI 바인딩
import { GolfGame, CLUBS, COURSES, PLAYER_COLORS } from './game.js';
import { PoseSwing, SwingState } from './pose.js';
import { Scene3D } from './scene3d.js';
import { Sfx } from './audio.js';

const $ = (id) => document.getElementById(id);

// --- 캔버스 ---
const fieldCanvas = $('field');
const miniCanvas = $('minimap');
const overlay = $('poseOverlay');
const video = $('cam');

miniCanvas.width = 168; miniCanvas.height = 232;

const game = new GolfGame(miniCanvas);
const scene3d = new Scene3D(fieldCanvas);
const pose = new PoseSwing(video, overlay);
const sfx = new Sfx();

// 3D 렌더러 크기 = 필드 컨테이너
function fitField() {
  const wrap = fieldCanvas.parentElement;
  scene3d.resize(wrap.clientWidth, wrap.clientHeight);
}
window.addEventListener('resize', fitField);

// 홀/코스가 바뀌면 3D 월드 재생성 · 턴 바뀌면 카메라 스냅
game.onHoleReady = () => scene3d.buildHole(game);
game.onTurn = () => scene3d.snap();

// 효과음 (첫 사용자 제스처에서 오디오 활성화)
let audioArmed = false;
function armAudio() { if (!audioArmed) { sfx.resume(); audioArmed = true; } }
window.addEventListener('pointerdown', armAudio);
window.addEventListener('keydown', armAudio);
game.onWater = () => sfx.water();
game.onLand = () => sfx.land();

// -------------------------------------------------------------------------
// 파워 게이지 상태 (키보드 3단 클릭 방식 & 웹캠 표시 공용)
// -------------------------------------------------------------------------
const gauge = {
  mode: 'idle',       // idle | power | accuracy
  value: 0,           // 0~100 표시값
  power: 0,
  accuracy: 0,        // -1~1
  dir: 1,
  swept: 0,
};

// -------------------------------------------------------------------------
// UI 갱신
// -------------------------------------------------------------------------
function setMessage(text, big = false) {
  const el = $('message');
  el.textContent = text;
  el.classList.toggle('big', big);
  if (big) {
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
  }
}
game.onMessage = setMessage;

game.onState = (s) => {
  $('courseName').textContent = s.course;
  $('courseDiff').textContent = '★'.repeat(s.stars) + '☆'.repeat(3 - s.stars);
  $('holeName').textContent = s.hole;
  $('holeCount').textContent = `(${s.holeNum}/${s.holeCount})`;
  $('par').textContent = `PAR ${s.par}`;
  $('strokes').textContent = s.strokes;
  $('remaining').textContent = `${s.remaining} yd`;
  $('lastShot').textContent = s.lastShotYards ? `${s.lastShotYards} yd` : '– yd';
  // 조준
  const aimEl = $('aimText');
  if (s.aim === 0) aimEl.textContent = '정조준';
  else aimEl.textContent = s.aim < 0 ? `◀ ${Math.abs(s.aim)}°` : `${s.aim}° ▶`;
  $('aimPill').classList.toggle('off', s.aim !== 0);
  // 바람 표시
  const wp = $('windPill');
  if (s.wind.speed < 1) {
    $('windText').textContent = '무풍';
    wp.classList.remove('strong');
  } else {
    const arrow = s.wind.cross >= 0 ? '→' : '←';   // 크로스 방향
    const head = s.wind.head > 1 ? ' ↑맞' : s.wind.head < -1 ? ' ↓뒤' : '';
    $('windText').textContent = `${arrow}${s.wind.speed}${head}`;
    wp.classList.toggle('strong', s.wind.speed >= 8);
  }
  // 클럽 버튼 활성/추천
  for (const key of Object.keys(CLUBS)) {
    const btn = $(`club-${key}`);
    if (!btn) continue;
    btn.classList.toggle('active', key === s.club);
    btn.classList.toggle('recommend', key === s.recommend && key !== s.club);
  }
  renderScoreboard(s.players, s.activeName);
};

// 멀티플레이어 스코어보드
function renderScoreboard(players, activeName) {
  const el = $('scoreboard');
  if (!players || players.length <= 1) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `<div class="sb-turn">${activeName} 차례</div>` + players.map((p) => `
    <div class="sb-row ${p.active ? 'active' : ''} ${p.done ? 'done' : ''}">
      <span class="sb-dot" style="background:${p.color}"></span>
      <span class="sb-name">${p.name}</span>
      <span class="sb-hole">${p.holeStrokes != null ? p.holeStrokes + '타' : (p.done ? '✓' : '–')}</span>
      <span class="sb-total">${p.total}</span>
    </div>`).join('');
}

game.onShot = (info) => {
  $('lastShot').textContent = `${info.carry} yd`;
  const p = $('shotPill');
  p.classList.remove('flash'); void p.offsetWidth; p.classList.add('flash');
  sfx.hit(info.power);                 // 타격음
};

game.onHoled = (strokes, par, isFinal) => {
  sfx.hole();                          // 홀인음
  $('nextHoleBtn').textContent = isFinal ? '코스 완주 ▶' : '다음 ▶';
  $('nextHoleBtn').style.display = 'inline-flex';
};

game.onCourseComplete = (board, course) => {
  const sorted = [...board].sort((a, b) => a.total - b.total);
  const rank = sorted.map((p, i) => `${i + 1}. ${p.name} ${p.total}타`).join('   ');
  const winner = board.length > 1 ? `🏆 우승 ${sorted[0].name}! — ` : '';
  showCourseSelect(`🏁 ${course.name} 완주! ${winner}${rank}`);
};

// 클럽 버튼
for (const key of Object.keys(CLUBS)) {
  $(`club-${key}`).addEventListener('click', () => game.setClub(key));
}
// 숫자키 1/2/3 클럽 선택 · ← → 조준
window.addEventListener('keydown', (e) => {
  if (e.key === '1') game.setClub('driver');
  else if (e.key === '2') game.setClub('iron');
  else if (e.key === '3') game.setClub('putter');
  else if (e.key === 'ArrowLeft') { e.preventDefault(); game.adjustAim(-2); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); game.adjustAim(2); }
});

$('nextHoleBtn').addEventListener('click', () => {
  $('nextHoleBtn').style.display = 'none';
  game.advance();
});

// -------------------------------------------------------------------------
// 코스 선택 오버레이
// -------------------------------------------------------------------------
const overlayEl = $('courseOverlay');
let started = false;

function buildCourseCards() {
  const grid = $('courseGrid');
  grid.innerHTML = '';
  const diffClass = { 초급: 'easy', 중급: 'mid', 고급: 'hard' };
  for (const c of COURSES) {
    const totalYd = c.holes.reduce((a, h) => a + h.total, 0);
    const par = c.holes.reduce((a, h) => a + h.par, 0);
    const card = document.createElement('button');
    card.className = `course-card ${diffClass[c.difficulty] || ''}`;
    card.innerHTML = `
      <div class="cc-top">
        <span class="cc-diff">${c.difficulty}</span>
        <span class="cc-stars">${'★'.repeat(c.stars)}${'☆'.repeat(3 - c.stars)}</span>
      </div>
      <h3>${c.name}</h3>
      <p class="cc-desc">${c.desc}</p>
      <div class="cc-meta">
        <span>${c.holes.length}홀</span>
        <span>파 ${par}</span>
        <span>${totalYd}yd</span>
        <span>${c.windMax === 0 ? '무풍' : '바람 ~' + c.windMax}</span>
      </div>`;
    card.addEventListener('click', () => {
      $('nextHoleBtn').style.display = 'none';
      armAudio();
      const names = Array.from({ length: playerCount }, (_, i) => playerNames[i] || '');
      game.selectCourse(c.id, playerCount, names);
      hideCourseSelect();
      started = true;
    });
    grid.appendChild(card);
  }
}

// 플레이어 수(1~4) + 이름 입력
let playerCount = 1;
const playerNames = [];
function initPlayerPicker() {
  const wrap = $('playerPick');
  wrap.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      playerCount = parseInt(b.dataset.n, 10);
      wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
      renderNameInputs(playerCount);
    });
  });
  renderNameInputs(playerCount);
}
function renderNameInputs(n) {
  const wrap = $('playerNames');
  if (n < 2) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = Array.from({ length: n }, (_, i) =>
    `<label class="pname-field"><span class="pname-dot" style="background:${PLAYER_COLORS[i]}"></span>
     <input class="pname" data-i="${i}" maxlength="10" placeholder="P${i + 1}" value="${(playerNames[i] || '').replace(/"/g, '')}"></label>`
  ).join('');
  wrap.querySelectorAll('.pname').forEach((inp) => {
    inp.addEventListener('input', () => { playerNames[inp.dataset.i] = inp.value; });
  });
}

function showCourseSelect(footMsg = '') {
  $('overlayFoot').textContent = footMsg;
  overlayEl.classList.add('show');
}
function hideCourseSelect() {
  overlayEl.classList.remove('show');
}
$('courseBtn').addEventListener('click', () => showCourseSelect(started ? '코스를 바꾸면 현재 라운드는 초기화됩니다.' : ''));

// 소리 켜기/끄기
let soundOn = true;
$('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  sfx.toggle(soundOn);
  $('soundBtn').textContent = soundOn ? '🔊' : '🔇';
  if (soundOn) { armAudio(); sfx.hit(50); }
});

// -------------------------------------------------------------------------
// 파워 게이지 렌더 (좌측 대형 세로 바)
// -------------------------------------------------------------------------
const gCanvas = $('gauge');
const gctx = gCanvas.getContext('2d');
gCanvas.width = 90; gCanvas.height = 340;

function renderGauge() {
  const ctx = gctx, W = gCanvas.width, H = gCanvas.height;
  ctx.clearRect(0, 0, W, H);
  const pad = 14;
  const barW = 42, barX = (W - barW) / 2;
  const barY = pad, barH = H - pad * 2;

  // 트랙
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  roundRect(ctx, barX, barY, barW, barH, 10); ctx.fill();

  // 존 그라데이션(빨강 상단=파워max, 초록 하단)
  const grad = ctx.createLinearGradient(0, barY, 0, barY + barH);
  grad.addColorStop(0, '#ff4d4f');
  grad.addColorStop(0.35, '#ffd43b');
  grad.addColorStop(1, '#51cf66');

  const v = gauge.value / 100;
  const fillH = barH * v;
  ctx.save();
  roundRect(ctx, barX, barY, barW, barH, 10); ctx.clip();
  ctx.fillStyle = grad;
  ctx.fillRect(barX, barY + barH - fillH, barW, fillH);
  ctx.restore();

  // 파워 락 마커
  if (gauge.mode === 'accuracy') {
    const y = barY + barH - barH * (gauge.power / 100);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(barX - 4, y); ctx.lineTo(barX + barW + 4, y); ctx.stroke();
  }

  // 정확도 스윗스팟(중앙) 표시 : accuracy 모드일 때 좌우 바
  // 값 텍스트
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(gauge.value)}`, W / 2, H - 2);

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText('POWER', W / 2, 10);
}

// 정확도 바(하단 수평)
const aCanvas = $('accuracyBar');
const actx = aCanvas.getContext('2d');
aCanvas.width = 300; aCanvas.height = 40;
function renderAccuracy() {
  const ctx = actx, W = aCanvas.width, H = aCanvas.height;
  ctx.clearRect(0, 0, W, H);
  const y = H / 2;
  // 트랙
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  roundRect(ctx, 8, y - 8, W - 16, 16, 8); ctx.fill();
  // 스윗스팟(중앙)
  ctx.fillStyle = 'rgba(81,207,102,0.9)';
  roundRect(ctx, W / 2 - 14, y - 8, 28, 16, 8); ctx.fill();
  // 마커
  const show = gauge.mode === 'accuracy' || Math.abs(gauge.accuracy) > 0.001;
  if (show) {
    const mx = W / 2 + gauge.accuracy * (W / 2 - 12);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(mx, y - 12); ctx.lineTo(mx, y + 12); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('◀ 훅        정확도        슬라이스 ▶', W / 2, H - 3);
}

// -------------------------------------------------------------------------
// 키보드 파워게이지(스페이스 3단): 시작→파워락→정확도락→발사
// -------------------------------------------------------------------------
function keyboardSpace() {
  if (game.isBusy()) return;
  if (mode !== 'keyboard') return;
  if (gauge.mode === 'idle') {
    gauge.mode = 'power'; gauge.value = 0; gauge.dir = 1;
    setMessage('스페이스로 파워를 멈추세요');
  } else if (gauge.mode === 'power') {
    gauge.power = gauge.value;
    gauge.mode = 'accuracy'; gauge.value = 50; gauge.accuracy = 0; gauge.dir = 1; gauge.swept = 0;
    setMessage('스페이스로 정확도를 맞추세요');
  } else if (gauge.mode === 'accuracy') {
    gauge.mode = 'idle';
    game.hit(gauge.power, gauge.accuracy);
    gauge.value = 0;
  }
}

// 게이지 자동 진동 업데이트
let lastTs = performance.now();
function updateGauge(dt) {
  if (gauge.mode === 'power') {
    gauge.value += gauge.dir * 130 * dt; // 초당 속도
    if (gauge.value >= 100) { gauge.value = 100; gauge.dir = -1; }
    if (gauge.value <= 0) { gauge.value = 0; gauge.dir = 1; }
  } else if (gauge.mode === 'accuracy') {
    // 좌우 스윙하는 마커 → accuracy -1~1
    gauge.swept += gauge.dir * 2.2 * dt;
    if (gauge.swept >= 1) { gauge.swept = 1; gauge.dir = -1; }
    if (gauge.swept <= -1) { gauge.swept = -1; gauge.dir = 1; }
    gauge.accuracy = gauge.swept;
  }
}

// -------------------------------------------------------------------------
// 모드 전환
// -------------------------------------------------------------------------
let mode = 'keyboard'; // 'keyboard' | 'webcam'

async function enableWebcam() {
  setMessage('AI 모델 로딩 중… (최초 1회, 잠시만요)');
  $('camStatus').textContent = '● 로딩중';
  const ok = await pose.init();
  if (!ok) {
    setMessage('AI 모델 로드 실패 — 키보드 모드로 진행하세요');
    $('camStatus').textContent = '● 실패';
    return false;
  }
  try {
    await pose.startCamera();
  } catch (e) {
    console.error(e);
    setMessage('웹캠 접근 실패(권한을 허용해 주세요) — 키보드 모드 유지');
    $('camStatus').textContent = '● 권한거부';
    return false;
  }
  pose.start();
  $('camStatus').textContent = '● 인식중';
  setMessage('카메라 앞에서 공을 내려다보는 어드레스 자세를 취하세요');
  return true;
}

pose.onState = (s) => {
  const map = {
    [SwingState.IDLE]: '대기',
    [SwingState.ADDRESS]: '어드레스 ✓',
    [SwingState.BACKSWING]: '백스윙 ↑',
    [SwingState.DOWNSWING]: '다운스윙 ↓',
    [SwingState.FINISH]: '팔로스루~피니시',
    [SwingState.IMPACT]: '샷! ⛳',
  };
  $('swingState').textContent = map[s] || s;
  // 파워게이지에 백스윙 반영(연출)
  if (s === SwingState.BACKSWING) { gauge.value = 60; }
};

// 추적 품질 바
pose.onQuality = (q) => {
  const fill = $('qFill');
  fill.style.width = `${Math.round(q * 100)}%`;
  fill.style.background = q > 0.7 ? '#51cf66' : q > 0.4 ? '#ffd43b' : '#ff6b6b';
  const hint = $('qHint');
  if (q === 0) hint.textContent = '사람이 안 보여요';
  else if (q < 0.5) hint.textContent = '상반신이 다 보이게 뒤로';
  else hint.textContent = '인식 양호 · 스윙하세요';
};

pose.onImpact = ({ power, accuracy }) => {
  if (mode !== 'webcam') return;
  gauge.value = power;
  gauge.accuracy = accuracy;
  game.hit(power, accuracy);
};

$('modeKeyboard').addEventListener('click', () => switchMode('keyboard'));
$('modeWebcam').addEventListener('click', () => switchMode('webcam'));

async function switchMode(m) {
  if (m === mode && m === 'webcam') return;
  if (m === 'webcam') {
    const ok = await enableWebcam();
    if (!ok) { switchMode('keyboard'); return; }
    mode = 'webcam';
    pose.setArmed(true);
    $('camPanel').classList.add('show');
    document.body.classList.add('webcam-mode');
  } else {
    mode = 'keyboard';
    pose.setArmed(false);
    $('camPanel').classList.remove('show');
    document.body.classList.remove('webcam-mode');
    setMessage('키보드 모드 — 스페이스로 파워게이지를 조작하세요');
  }
  $('modeKeyboard').classList.toggle('active', mode === 'keyboard');
  $('modeWebcam').classList.toggle('active', mode === 'webcam');
}

// 스페이스/엔터 = 게이지 조작
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (game.hole.holed) { // 홀아웃 상태에서 스페이스 = 다음(플레이어/홀)
      $('nextHoleBtn').style.display = 'none';
      game.advance();
      return;
    }
    keyboardSpace();
  }
});

// -------------------------------------------------------------------------
// 메인 루프
// -------------------------------------------------------------------------
function loop(now) {
  const dt = Math.min(0.05, (now - lastTs) / 1000);
  lastTs = now;
  updateGauge(dt);
  game.update(now);            // 비행 종료/착지 판정
  scene3d.render(now, game);   // 3D 필드
  game.renderMini();           // 미니맵 HUD
  renderGauge();
  renderAccuracy();
  requestAnimationFrame(loop);
}

// -------------------------------------------------------------------------
// 초기화
// -------------------------------------------------------------------------
function init() {
  fitField();
  buildCourseCards();
  initPlayerPicker();
  scene3d.buildHole(game);  // 초기 3D 월드
  game.setClub('driver');   // 콜백 등록 후 초기 UI(클럽 활성/추천) 반영
  setMessage('코스를 선택하면 라운딩이 시작됩니다');
  $('modeKeyboard').classList.add('active');
  showCourseSelect();       // 시작 시 코스 선택 화면
  requestAnimationFrame((t) => { lastTs = t; loop(t); });
}
init();

// 디버그용 노출
window.__game = game;
window.__pose = pose;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
