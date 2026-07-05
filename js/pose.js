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
  lPinky: 17, rPinky: 18,
  lIndex: 19, rIndex: 20,
  lThumb: 21, rThumb: 22,
  lHip: 23, rHip: 24,
};

export const SwingState = {
  IDLE: 'IDLE',
  ADDRESS: 'ADDRESS',
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
    this.onState = () => {};
    this.onImpact = () => {};
    this.onReady = () => {};
    this.onError = () => {};
    this.onQuality = () => {};   // (0~1 추적 품질)

    this.state = SwingState.IDLE;
    this.smoothLm = null;        // EMA 스무딩된 랜드마크
    this._reset();

    // 감도 파라미터(튜닝 가능)
    this.cfg = {
      smoothing: 0.55,         // EMA 계수(0=안함, 1=고정). 클수록 부드럽지만 지연↑
      minVisibility: 0.4,      // 이 미만 신뢰도의 손목은 추적 보류
      addressStillFrames: 6,
      stillThresh: 0.012,
      backswingRise: 0.10,
      impactVel: 1.5,
      maxVel: 5.5,
      armedEnabled: true,
    };
  }

  _reset() {
    this.addressY = null;
    this.addressX = null;
    this.topY = 1;
    this.topX = null;
    this.stillCount = 0;
    this.prev = null;
    this.peakVel = 0;
    this.peakVelX = null;
  }

  async init() {
    try {
      const fileset = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm'
      );
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          // full 모델 : lite 보다 팔·손 추적 정확도가 훨씬 좋음
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
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
        try {
          const res = this.landmarker.detectForVideo(this.video, performance.now());
          this._process(res);
        } catch (e) { /* 프레임 스킵 */ }
      }
    }
    requestAnimationFrame(() => this._loop());
  }

  _process(res) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!res || !res.landmarks || res.landmarks.length === 0) {
      this.smoothLm = null;
      this.onQuality(0);
      this._setState(SwingState.IDLE);
      return;
    }

    // EMA 스무딩 : 지터 감소로 추적이 "따라오는" 느낌 개선
    const raw = res.landmarks[0];
    const a = this.cfg.smoothing;
    if (!this.smoothLm) {
      this.smoothLm = raw.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility ?? 1 }));
    } else {
      for (let i = 0; i < raw.length; i++) {
        const s = this.smoothLm[i], p = raw[i];
        s.x = a * s.x + (1 - a) * p.x;
        s.y = a * s.y + (1 - a) * p.y;
        s.visibility = p.visibility ?? 1;
      }
    }
    const lm = this.smoothLm;
    this._draw(lm);

    // 추적 품질 = 상체 핵심 관절 신뢰도 평균
    const q = avgVis(lm, [LM.lShoulder, LM.rShoulder, LM.lElbow, LM.rElbow, LM.lWrist, LM.rWrist]);
    this.onQuality(q);

    const wrist = midpoint(lm[LM.lWrist], lm[LM.rWrist]);
    const shoulder = midpoint(lm[LM.lShoulder], lm[LM.rShoulder]);
    const hip = midpoint(lm[LM.lHip], lm[LM.rHip]);

    // 손목 신뢰도가 너무 낮으면 스윙 추적 보류(오검출 방지)
    const wristVis = ((lm[LM.lWrist].visibility ?? 1) + (lm[LM.rWrist].visibility ?? 1)) / 2;
    if (wristVis < this.cfg.minVisibility) {
      this.prev = null;
      return;
    }

    const now = performance.now();
    const cur = { x: wrist.x, y: wrist.y, t: now };

    let vy = 0, vx = 0, speed = 0;
    if (this.prev) {
      const dt = Math.max(0.001, (now - this.prev.t) / 1000);
      vy = (cur.y - this.prev.y) / dt;
      vx = (cur.x - this.prev.x) / dt;
      speed = Math.hypot(vx, vy);
    }

    if (this.cfg.armedEnabled) this._swingFSM(cur, shoulder, hip, vy, vx, speed);
    this.prev = cur;
  }

  _swingFSM(cur, shoulder, hip, vy, vx, speed) {
    const c = this.cfg;
    switch (this.state) {
      case SwingState.IDLE:
      case SwingState.ADDRESS: {
        const handsLow = cur.y > (shoulder.y + hip.y) / 2 - 0.05;
        if (handsLow && speed < c.stillThresh * 60) this.stillCount++;
        else this.stillCount = 0;

        if (this.state !== SwingState.ADDRESS && handsLow) {
          this._setState(SwingState.ADDRESS);
          this.onReady();
        }
        if (this.state === SwingState.ADDRESS && this.stillCount >= c.addressStillFrames) {
          this.addressY = cur.y; this.addressX = cur.x;
          this.topY = cur.y; this.topX = cur.x;
        }
        if (this.addressY != null && cur.y < this.addressY - c.backswingRise && vy < 0) {
          this._setState(SwingState.BACKSWING);
          this.topY = cur.y; this.topX = cur.x; this.peakVel = 0;
        }
        break;
      }
      case SwingState.BACKSWING: {
        if (cur.y < this.topY) { this.topY = cur.y; this.topX = cur.x; }
        if (vy > c.stillThresh * 20 && cur.y > this.topY + 0.02) {
          this._setState(SwingState.DOWNSWING);
          this.peakVel = 0; this.peakVelX = cur.x;
        }
        break;
      }
      case SwingState.DOWNSWING: {
        if (vy > this.peakVel) { this.peakVel = vy; this.peakVelX = cur.x; }
        const backHome = this.addressY != null && cur.y >= this.addressY - 0.06;
        if (backHome && this.peakVel > c.impactVel) this._fireImpact();
        else if (this.addressY != null && cur.y > this.addressY + 0.06 && this.peakVel > 0.5) this._fireImpact();
        break;
      }
      default: break;
    }
  }

  _fireImpact() {
    const c = this.cfg;
    const power = clamp((this.peakVel / c.maxVel) * 100, 5, 100);
    let accuracy = 0;
    if (this.topX != null && this.peakVelX != null) {
      const drift = this.peakVelX - (this.addressX ?? this.topX);
      accuracy = clamp(drift * 4.0, -1, 1);
    }
    this._setState(SwingState.IMPACT);
    this.onImpact({ power, accuracy, speed: this.peakVel });
    setTimeout(() => { this._reset(); this._setState(SwingState.IDLE); }, 600);
  }

  _setState(s) {
    if (this.state !== s) { this.state = s; this.onState(s); }
  }

  // 스켈레톤 오버레이 (팔·손 강조)
  _draw(lm) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;

    const bones = [
      [LM.lShoulder, LM.rShoulder],
      [LM.lShoulder, LM.lElbow], [LM.lElbow, LM.lWrist],
      [LM.rShoulder, LM.rElbow], [LM.rElbow, LM.rWrist],
      [LM.lShoulder, LM.lHip], [LM.rShoulder, LM.rHip],
      [LM.lHip, LM.rHip],
      // 손 : 손목 → 손가락
      [LM.lWrist, LM.lIndex], [LM.lWrist, LM.lPinky], [LM.lWrist, LM.lThumb],
      [LM.rWrist, LM.rIndex], [LM.rWrist, LM.rPinky], [LM.rWrist, LM.rThumb],
    ];

    // 팔은 굵게 강조
    for (const [a, b] of bones) {
      const pa = lm[a], pb = lm[b];
      if (!pa || !pb) continue;
      const armBone = (a === LM.lElbow || a === LM.rElbow || b === LM.lWrist || b === LM.rWrist);
      ctx.lineWidth = armBone ? 6 : 4;
      ctx.strokeStyle = armBone ? 'rgba(255,212,59,0.95)' : 'rgba(80,220,120,0.85)';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pa.x * W, pa.y * H);
      ctx.lineTo(pb.x * W, pb.y * H);
      ctx.stroke();
    }

    // 관절 점
    const joints = [
      LM.lShoulder, LM.rShoulder, LM.lElbow, LM.rElbow,
      LM.lWrist, LM.rWrist, LM.lIndex, LM.rIndex,
    ];
    for (const k of joints) {
      const p = lm[k];
      if (!p) continue;
      const isWrist = (k === LM.lWrist || k === LM.rWrist);
      ctx.fillStyle = isWrist ? '#ffd43b' : '#fff';
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, isWrist ? 9 : 5, 0, Math.PI * 2);
      ctx.fill();
      if (isWrist) {
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  }
}

function midpoint(a, b) {
  if (!a) return b; if (!b) return a;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function avgVis(lm, idxs) {
  let s = 0, n = 0;
  for (const i of idxs) { if (lm[i]) { s += (lm[i].visibility ?? 1); n++; } }
  return n ? s / n : 0;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
