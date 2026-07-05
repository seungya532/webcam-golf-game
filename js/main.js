// main.js
// 전체 연결 : 게임 루프 · 웹캠(포즈) 모드 · 키보드(파워게이지) 모드 · UI 바인딩
import { GolfGame, CLUBS } from './game.js';
import { PoseSwing, SwingState } from './pose.js';

const $ = (id) => document.getElementById(id);

// --- 캔버스 ---
const fieldCanvas = $('field');
const miniCanvas = $('minimap');
const overlay = $('poseOverlay');
const video = $('cam');

// 게임 픽셀 크기(내부 해상도)
function fitField() {
  const wrap = fieldCanvas.parentElement;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  fieldCanvas.width = w;
  fieldCanvas.height = h;
}
window.addEventListener('resize', fitField);

miniCanvas.width = 150; miniCanvas.height = 200;

const game = new GolfGame(fieldCanvas, miniCanvas);
const pose = new PoseSwing(video, overlay);

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
  $('holeName').textContent = s.hole;
  $('par').textContent = `PAR ${s.par}`;
  $('strokes').textContent = s.strokes;
  $('remaining').textContent = `${s.remaining} yd`;
  // 클럽 버튼 활성/추천
  for (const key of Object.keys(CLUBS)) {
    const btn = $(`club-${key}`);
    if (!btn) continue;
    btn.classList.toggle('active', key === s.club);
    btn.classList.toggle('recommend', key === s.recommend && key !== s.club);
  }
};

game.onHoled = () => {
  $('nextHoleBtn').style.display = 'inline-flex';
};

// 클럽 버튼
for (const key of Object.keys(CLUBS)) {
  $(`club-${key}`).addEventListener('click', () => game.setClub(key));
}
// 숫자키 1/2/3 클럽 선택
window.addEventListener('keydown', (e) => {
  if (e.key === '1') game.setClub('driver');
  else if (e.key === '2') game.setClub('iron');
  else if (e.key === '3') game.setClub('putter');
});

$('nextHoleBtn').addEventListener('click', () => {
  $('nextHoleBtn').style.display = 'none';
  game.nextHole();
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
    [SwingState.IMPACT]: '임팩트!',
  };
  $('swingState').textContent = map[s] || s;
  // 파워게이지에 백스윙 반영(연출)
  if (s === SwingState.BACKSWING) { gauge.value = 60; }
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
    if (game.hole.holed) { // 홀아웃 상태에서 스페이스 = 다음 홀
      $('nextHoleBtn').style.display = 'none';
      game.nextHole();
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
  game.render(now);
  renderGauge();
  renderAccuracy();
  requestAnimationFrame(loop);
}

// -------------------------------------------------------------------------
// 초기화
// -------------------------------------------------------------------------
function init() {
  fitField();
  game.setClub('driver');   // 콜백 등록 후 초기 UI(클럽 활성/추천) 반영
  game.onMessage(`${game.hole.name} · 파 ${game.hole.par} · ${game.hole.total}yd`);
  setMessage('키보드 모드 — 스페이스로 파워게이지를 조작하세요');
  $('modeKeyboard').classList.add('active');
  requestAnimationFrame((t) => { lastTs = t; loop(t); });
}
init();

// 디버그용 노출
window.__game = game;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
