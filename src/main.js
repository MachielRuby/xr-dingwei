/**
 * XR SLAM 空间定位 — 单 Canvas 方案
 *
 * 关键发现：
 *   xr.js 内部通过 dynamic import() 加载 xr-slam.js 来创建 XrController
 *   XR8.XrController 一开始是 null，只有在 loadChunk("slam") 完成后才可用
 *   所以必须先调用 loadChunk，等 XrController 就绪后再注册 pipeline
 */

const xrCanvas  = document.getElementById('xr-canvas');
const tipEl     = document.getElementById('tip');
const countEl   = document.getElementById('count');
const loadingEl = document.getElementById('loading');

let scene, camera, renderer, reticle;
let canPlace   = false;
let placeCount = 0;
let hasLoggedReality = false;

// 瞄准环平滑插值用
const _retPos  = { x: 0, y: 0, z: 0 };
const _retQuat = { x: 0, y: 0, z: 0, w: 1 };
let   _retReady = false;

// ─── Three.js 初始化（共享 XR8 的 WebGL 上下文） ─────────────────────────────
function initThree(canvas, glContext, w, h) {
  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);

  renderer = new THREE.WebGLRenderer({
    canvas,
    context: glContext,
    alpha: true,
    antialias: true,
  });
  renderer.autoClear = false;
  renderer.setSize(w, h, false);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(2, 5, 3);
  scene.add(sun);

  const ringGeo = new THREE.RingGeometry(0.06, 0.095, 36);
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  reticle = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0x00e6c8, side: THREE.DoubleSide,
    depthTest: false, transparent: true, opacity: 0.9,
  }));
  reticle.visible = false;
  scene.add(reticle);

  console.log('[INIT] Three.js ready:', w, 'x', h);
}

// ─── 放置锚定模型 ────────────────────────────────────────────────────────────
function placeAnchoredModel(pos, rot) {
  const group = new THREE.Group();
  group.position.set(pos.x, pos.y, pos.z);
  if (rot) group.quaternion.set(rot.x, rot.y, rot.z, rot.w);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.18, 0.18),
    new THREE.MeshPhongMaterial({ color: 0x00e6c8, emissive: 0x003333, shininess: 90 })
  );
  cube.position.y = 0.09;
  cube.userData.spin = true;
  group.add(cube);

  const markGeo = new THREE.RingGeometry(0.09, 0.12, 36);
  markGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  group.add(new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({
    color: 0x00e6c8, side: THREE.DoubleSide,
    transparent: true, opacity: 0.45, depthTest: false,
  })));

  scene.add(group);
  placeCount++;
  countEl.textContent = `已放置：${placeCount}`;
  console.log('[PLACE] placed at', pos);
}

// ─── 触摸/点击放置 ───────────────────────────────────────────────────────────
function tryPlace(clientX, clientY) {
  if (!canPlace || !XR8.XrController || !XR8.XrController.hitTest) return;
  const rect = xrCanvas.getBoundingClientRect();
  const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const ny = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  const hits = XR8.XrController.hitTest(nx, ny, ['ESTIMATED_SURFACE', 'FEATURE_POINT']);
  if (hits && hits.length) {
    placeAnchoredModel(hits[0].position, hits[0].rotation);
  }
}

// ─── 等待 XR8 就绪 ───────────────────────────────────────────────────────────
const XR_TIMEOUT = 15000;
const xrTimer = setTimeout(() => {
  loadingEl.querySelector('span').textContent = '⚠️ AR 引擎加载超时';
}, XR_TIMEOUT);

const onXRLoad = async () => {
  clearTimeout(xrTimer);
  console.log('[XR] XR8 loaded, version:', XR8.version);

  // ★ 关键步骤：先让 XR8 加载 SLAM 模块（它会 dynamic import xr-slam.js 并创建 XrController）
  try {
    console.log('[XR] Loading SLAM chunk...');
    await XR8.loadChunk('slam');
    console.log('[XR] SLAM chunk loaded. XrController:', XR8.XrController);
  } catch (e) {
    console.error('[XR] Failed to load SLAM chunk:', e);
    loadingEl.querySelector('span').textContent = '⚠️ SLAM 模块加载失败';
    return;
  }

  if (!XR8.XrController) {
    console.error('[XR] XrController is still null after loadChunk!');
    loadingEl.querySelector('span').textContent = '⚠️ XrController 初始化失败';
    return;
  }

  // ═══ 注册 Pipeline 模块 ═══

  // 1. 摄像头画面渲染
  XR8.addCameraPipelineModule(XR8.GlTextureRenderer.pipelineModule());

  // 2. ★ SLAM 控制器（现在它已经加载好了）
  XR8.addCameraPipelineModule(XR8.XrController.pipelineModule());

  // 3. 我们的业务逻辑
  XR8.addCameraPipelineModule({
    name: 'slam-demo',

    onStart({ canvas, canvasWidth, canvasHeight, GLctx }) {
      console.log('[PIPELINE] onStart:', canvasWidth, 'x', canvasHeight);
      initThree(canvas, GLctx, canvasWidth, canvasHeight);
      loadingEl.classList.add('hide');
    },

    onUpdate({ processCpuResult }) {
      const reality = processCpuResult?.reality;

      if (reality && !hasLoggedReality) {
        hasLoggedReality = true;
        console.log('[SLAM] First reality data, keys:', Object.keys(reality));
        if (reality.trackingStatus) console.log('[SLAM] trackingStatus:', reality.trackingStatus);
      }

      if (!reality) return;

      // 同步 SLAM 相机姿态到 Three.js
      if (reality.intrinsics) {
        for (let i = 0; i < 16; i++)
          camera.projectionMatrix.elements[i] = reality.intrinsics[i];
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
      if (reality.rotation) {
        const { x, y, z, w } = reality.rotation;
        camera.quaternion.set(x, y, z, w);
      }
      if (reality.position) {
        const { x, y, z } = reality.position;
        camera.position.set(x, y, z);
      }

      // 屏幕中心射线碰撞
      if (XR8.XrController.hitTest) {
        const hits = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE', 'FEATURE_POINT']);
        canPlace = !!(hits && hits.length);

        if (canPlace) {
          const { position: p, rotation: q } = hits[0];
          const lerpF = _retReady ? 0.2 : 1;   // 首次直接定位，之后平滑插值

          _retPos.x += (p.x - _retPos.x) * lerpF;
          _retPos.y += (p.y - _retPos.y) * lerpF;
          _retPos.z += (p.z - _retPos.z) * lerpF;
          reticle.position.set(_retPos.x, _retPos.y, _retPos.z);

          if (q) {
            _retQuat.x += (q.x - _retQuat.x) * lerpF;
            _retQuat.y += (q.y - _retQuat.y) * lerpF;
            _retQuat.z += (q.z - _retQuat.z) * lerpF;
            _retQuat.w += (q.w - _retQuat.w) * lerpF;
            reticle.quaternion.set(_retQuat.x, _retQuat.y, _retQuat.z, _retQuat.w).normalize();
          }
          _retReady = true;
          tipEl.textContent = '点击屏幕放置模型';
        } else {
          tipEl.textContent = '移动手机扫描地面...';
        }
        reticle.visible = canPlace;
      }

      scene.traverse(obj => { if (obj.userData.spin) obj.rotation.y += 0.012; });
    },

    onRender() {
      if (!renderer) return;
      renderer.clearDepth();
      renderer.render(scene, camera);
    },

    onCanvasSizeChange({ canvasWidth, canvasHeight }) {
      if (!renderer) return;
      renderer.setSize(canvasWidth, canvasHeight, false);
      camera.aspect = canvasWidth / canvasHeight;
      camera.updateProjectionMatrix();
    },
  });

  // 触摸放置
  window.addEventListener('touchstart', (e) => {
    e.preventDefault();
    tryPlace(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  // 鼠标放置
  window.addEventListener('click', (e) => {
    tryPlace(e.clientX, e.clientY);
  });

  // ═══ 设置 canvas 尺寸（消除拉伸变形）═══
  function resizeCanvas() {
    xrCanvas.width  = window.innerWidth;
    xrCanvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // ═══ 启动引擎 ═══
  XR8.run({
    canvas: xrCanvas,
    allowedDevices: XR8.XrConfig.device().ANY,
    cameraConfig: {
      direction: XR8.XrConfig.camera().BACK,
    },
  });

  console.log('[XR] XR8.run() called');
};

if (window.XR8) {
  onXRLoad();
} else {
  window.addEventListener('xrloaded', onXRLoad);
}
