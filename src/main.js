/**
 * XR SLAM 空间定位 — 主逻辑
 *
 * 依赖（由 index.html 以 <script> 顺序加载）：
 *   - XR8      : window.XR8      (xr.js)
 *   - THREE    : window.THREE    (three.min.js)
 *
 * 核心流程：
 *   1. XR8.GlTextureRenderer  → 将摄像头画面渲染到 #xr-canvas
 *   2. SLAM 管线模块           → 每帧同步 6DoF 相机姿态到 Three.js 相机
 *   3. XR8.XrController.hitTest → 屏幕中心射线检测平面
 *   4. 触摸时将模型固定到该世界坐标锚点
 */

// ─── DOM 引用 ────────────────────────────────────────────────────────────────
const xrCanvas    = document.getElementById('xr-canvas');
const threeCanvas = document.getElementById('three-canvas');
const tipEl       = document.getElementById('tip');
const countEl     = document.getElementById('count');
const loadingEl   = document.getElementById('loading');

// ─── 全局状态 ─────────────────────────────────────────────────────────────────
let THREE, scene, camera, renderer, reticle;
let canPlace   = false;
let placeCount = 0;

// ─── Three.js 初始化 ──────────────────────────────────────────────────────────
function initThree(w, h) {
  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.setClearAlpha(0);

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
}

// ─── 在 SLAM 世界坐标处放置锚定模型 ──────────────────────────────────────────
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
}

// ─── 触摸放置 ─────────────────────────────────────────────────────────────────
function onTouch(e) {
  if (!canPlace) return;
  e.preventDefault();
  const t = e.touches[0];
  const hits = XR8.XrController.hitTest(
    t.clientX / window.innerWidth,
    t.clientY / window.innerHeight,
    ['ESTIMATED_SURFACE', 'FEATURE_POINT']
  );
  if (hits && hits.length) placeAnchoredModel(hits[0].position, hits[0].rotation);
}

// ─── 启动入口：等 window.load 确保 xr.js 已同步执行完毕 ──────────────────────
window.addEventListener('load', () => {
  // 验证依赖是否存在
  if (typeof XR8 === 'undefined') {
    loadingEl.querySelector('span').textContent = '⚠️ AR 引擎加载失败，请用 HTTPS 访问';
    console.error('[XR] XR8 未定义。可能原因：\n  1. 页面未走 HTTPS（AR 摄像头权限要求 HTTPS）\n  2. CDN 已阻止当前域名访问');
    return;
  }
  THREE = window.THREE;

  // ─── XR8 SLAM 管线 ──────────────────────────────────────────────────────────
  XR8.addCameraPipelineModule(XR8.GlTextureRenderer.pipelineModule());

  XR8.addCameraPipelineModule({
    name: 'slam-demo',

    onStart({ canvas }) {
      initThree(canvas.width, canvas.height);
      loadingEl.classList.add('hide');
    },

    onUpdate({ processCpuResult }) {
      const reality = processCpuResult?.reality;
      if (!reality) return;

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

      const hits = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE', 'FEATURE_POINT']);
      canPlace = !!(hits && hits.length);

      if (canPlace) {
        const { position: p, rotation: q } = hits[0];
        reticle.position.set(p.x, p.y, p.z);
        if (q) reticle.quaternion.set(q.x, q.y, q.z, q.w);
        tipEl.textContent = '点击屏幕放置模型';
      } else {
        tipEl.textContent = '移动手机扫描地面...';
      }
      reticle.visible = canPlace;

      scene.traverse(obj => { if (obj.userData.spin) obj.rotation.y += 0.012; });
    },

    onRender() {
      if (renderer) renderer.render(scene, camera);
    },

    onCanvasSizeChange({ canvasWidth, canvasHeight }) {
      if (!renderer) return;
      renderer.setSize(canvasWidth, canvasHeight, false);
      camera.aspect = canvasWidth / canvasHeight;
      camera.updateProjectionMatrix();
    },
  });

  window.addEventListener('touchstart', onTouch, { passive: false });

  XR8.run({ canvas: xrCanvas });
});
