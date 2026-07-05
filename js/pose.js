// pose.js
// MediaPipe Pose Landmarker(tasks-vision) 로 웹캠에서 관절 33개를 추적하고,
// 손목 궤적으로 골프 스윙 상태 머신(어드레스→백스윙→다운스윙→임팩트)을 구동한다.
//
// CDN ESM import 만 사용 → 빌드/번들러 불필요, GH Pages 에서 그대로 동작.

import {
  PoseLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs';

// MediaPipe Pose 랜드마크 인덱스
const LM = {
  nose: 0,
  lShoulder: 11, rShoulder: 12,
  lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24,
};

// 스윙 상태
export const SwingState = {
  IDLE: 'IDLE',        // 사람 미인식
  ADDRESS: 'ADDRESS',  // 준비 자세(손 아래, 정지)
  BACKSWING: 'BACKSWING',
  DOWNSWING: 'DOWNSWING',
  IMPACT: 'IMPACT',
};

export class PoseSwing {
  constructor(video, overlayCanvas) {
    this.video = video;
    this.canvas = overlayCanvas;
    this.ctx = overlayCanvas.getContext('2d');

    this.landmarker = null;
    this.running = false;
    this.lastVideoTime = -1;

    // 콜백
    this.onState = () => {};      // (state)
    this.onImpact = () => {};     // ({power, accuracy})
    this.onReady = () => {};      // 사람 인식되어 어드레스 가능
    this.onError = () => {};

    // 스윙 추적 상태
    this.state = SwingState.IDLE;
    this._reset();

    // 감도 파라미터(튜닝 가능)
    this.cfg = {
      addressStillFrames: 6,   // 정지 판정 프레임
      stillThresh: 0.012,      // 정지로 볼 최대 이동량(정규화)
      backswingRise: 0.10,     // 어드레스 대비 이만큼 위로 올라가면 백스윙
      impactVel: 1.6,          // 임팩트로 인정할 최소 하강 속도(정규화/초)
      maxVel: 6.0,             // 파워 100 에 대응하는 속도
      armedEnabled: true,      // 스윙 인식 on/off
    };
  }

  _reset() {
    this.addressY = null;      // 어드레스 시 손 y
    this.addressX = null;
    this.topY = 1;             // 백스윙 최고점(최소 y)
    this.topX = null;
    this.stillCount = 0;
    this.prev = null;          // {x,y,t}
    this.peakVel = 0;
    this.peakVelX = null;      // 피크 시점의 x
  }

  async init() {
    try {
      const fileset = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm'
      );
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
      return true;
    } catch (e) {
      console.error(e);
      this.onError(e);
      return false;
    }
  }

  async startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    // 오버레이 캔버스 크기 = 비디오
    this.canvas.width = this.video.videoWidth || 640;
    this.canvas.height = this.video.videoHeight || 480;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    const s = this.video.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
  }

  setArmed(on) { this.cfg.armedEnabled = on; if (on) this._reset(); }

  _loop() {
    if (!this.running) return;
    if (this.landmarker && this.video.readyState >= 2) {
      const t = this.video.currentTime;
      if (t !== this.lastVideoTime) {
        this.lastVideoTime = t;
        const res = this.landmarker.detectForVideo(this.video, performance.now());
        this._process(res);
      }
    }
    requestAnimationFrame(() => this._loop());
  }

  _process(res) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!res || !res.landmarks || res.landmarks.length === 0) {
      this._setState(SwingState.IDLE);
      return;
    }
    const lm = res.landmarks[0];
    this._draw(lm);

    // 양 손목 평균 = 그립 위치
    const wrist = midpoint(lm[LM.lWrist], lm[LM.rWrist]);
    const shoulder = midpoint(lm[LM.lShoulder], lm[LM.rShoulder]);
    const hip = midpoint(lm[LM.lHip], lm[LM.rHip]);

    const now = performance.now();
    const cur = { x: wrist.x, y: wrist.y, t: now };

    // 속도(정규화 단위/초)
    let vy = 0, vx = 0, speed = 0;
    if (this.prev) {
      const dt = Math.max(0.001, (now - this.prev.t) / 1000);
      vy = (cur.y - this.prev.y) / dt;   // +면 아래로
      vx = (cur.x - this.prev.x) / dt;
      speed = Math.hypot(vx, vy);
    }

    if (this.cfg.armedEnabled) this._swingFSM(cur, shoulder, hip, vy, vx, speed);
    this.prev = cur;
  }

  // 스윙 상태 머신
  _swingFSM(cur, shoulder, hip, vy, vx, speed) {
    const c = this.cfg;

    switch (this.state) {
      case SwingState.IDLE:
      case SwingState.ADDRESS: {
        // 손이 어깨보다 아래(엉덩이 근처)이고 정지 → 어드레스
        const handsLow = cur.y > (shoulder.y + hip.y) / 2 - 0.05;
        if (handsLow && speed < c.stillThresh * 60) {
          this.stillCount++;
        } else {
          this.stillCount = 0;
        }
        if (this.state !== SwingState.ADDRESS && handsLow) {
          this._setState(SwingState.ADDRESS);
          this.onReady();
        }
        if (this.state === SwingState.ADDRESS && this.stillCount >= c.addressStillFrames) {
          // 어드레스 확정, 기준점 저장
          this.addressY = cur.y;
          this.addressX = cur.x;
          this.topY = cur.y;
          this.topX = cur.x;
        }
        // 어드레스 기준이 잡힌 뒤 위로 올라가기 시작하면 백스윙
        if (this.addressY != null && cur.y < this.addressY - c.backswingRise && vy < 0) {
          this._setState(SwingState.BACKSWING);
          this.topY = cur.y;
          this.topX = cur.x;
          this.peakVel = 0;
        }
        break;
      }

      case SwingState.BACKSWING: {
        // 계속 올라가는 동안 최고점 갱신
        if (cur.y < this.topY) {
          this.topY = cur.y;
          this.topX = cur.x;
        }
        // 방향 전환: 아래로 내려가기 시작 → 다운스윙
        if (vy > c.stillThresh * 20 && cur.y > this.topY + 0.02) {
          this._setState(SwingState.DOWNSWING);
          this.peakVel = 0;
          this.peakVelX = cur.x;
        }
        break;
      }

      case SwingState.DOWNSWING: {
        // 하강 최고속 추적
        if (vy > this.peakVel) {
          this.peakVel = vy;
          this.peakVelX = cur.x;
        }
        // 임팩트: 손이 어드레스 높이 근처로 복귀 + 충분한 속도
        const backHome = this.addressY != null && cur.y >= this.addressY - 0.06;
        if (backHome && this.peakVel > c.impactVel) {
          this._fireImpact();
        }
        // 안전장치: 손이 어드레스보다 훨씬 아래로 내려가면 강제 임팩트
        else if (this.addressY != null && cur.y > this.addressY + 0.06 && this.peakVel > 0.5) {
          this._fireImpact();
        }
        break;
      }
      default:
        break;
    }
  }

  _fireImpact() {
    const c = this.cfg;
    // 파워 = 피크 하강속도 → 0~100
    let power = clamp((this.peakVel / c.maxVel) * 100, 5, 100);

    // 정확도 = 백스윙 탑~임팩트 사이 좌우 흔들림(작을수록 정타)
    let accuracy = 0;
    if (this.topX != null && this.peakVelX != null) {
      const drift = this.peakVelX - (this.addressX ?? this.topX);
      // drift 양수(카메라 기준 오른쪽)를 오른쪽 밀림으로
      accuracy = clamp(drift * 4.0, -1, 1);
    }

    this._setState(SwingState.IMPACT);
    this.onImpact({ power, accuracy, speed: this.peakVel });

    // 다음 스윙을 위해 잠시 후 리셋(임팩트 상태 표시 유지)
    setTimeout(() => {
      this._reset();
      this._setState(SwingState.IDLE);
    }, 600);
  }

  _setState(s) {
    if (this.state !== s) {
      this.state = s;
      this.onState(s);
    }
  }

  // 스켈레톤 오버레이
  _draw(lm) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const bones = [
      [LM.lShoulder, LM.rShoulder],
      [LM.lShoulder, LM.lElbow], [LM.lElbow, LM.lWrist],
      [LM.rShoulder, LM.rElbow], [LM.rElbow, LM.rWrist],
      [LM.lShoulder, LM.lHip], [LM.rShoulder, LM.rHip],
      [LM.lHip, LM.rHip],
    ];
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(80,220,120,0.9)';
    for (const [a, b] of bones) {
      if (!lm[a] || !lm[b]) continue;
      ctx.beginPath();
      ctx.moveTo(lm[a].x * W, lm[a].y * H);
      ctx.lineTo(lm[b].x * W, lm[b].y * H);
      ctx.stroke();
    }
    // 핵심 관절 점
    const keys = [LM.lShoulder, LM.rShoulder, LM.lElbow, LM.rElbow, LM.lWrist, LM.rWrist];
    for (const k of keys) {
      const p = lm[k];
      if (!p) continue;
      const isWrist = k === LM.lWrist || k === LM.rWrist;
      ctx.fillStyle = isWrist ? '#ffd43b' : '#fff';
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, isWrist ? 8 : 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function midpoint(a, b) {
  if (!a) return b; if (!b) return a;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
