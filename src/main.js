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
const { THREE } = window;   // Three.js 由 CDN <script> 注入全局
let scene, camera, renderer, reticle;
let canPlace   = false;
let placeCount = 0;

// ─── Three.js 初始化 ──────────────────────────────────────────────────────────
function initThree(w, h) {
  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);

  // alpha:true 让摄像头画面透出来
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.setClearAlpha(0);

  // 灯光
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(2, 5, 3);
  scene.add(sun);

  // 准星（屏幕中心地面锚点指示器）
  const ringGeo = new THREE.RingGeometry(0.06, 0.095, 36);
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  reticle = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0x00e6c8,
    side: THREE.DoubleSide,
    depthTest: false,
    transparent: true,
    opacity: 0.9,
  }));
  reticle.visible = false;
  scene.add(reticle);
}

// ─── 在 SLAM 世界坐标处放置锚定模型 ──────────────────────────────────────────
/**
 * @param {{ x:number, y:number, z:number }} pos  SLAM 世界坐标
 * @param {{ x:number, y:number, z:number, w:number }|null} rot  朝向四元数
 */
function placeAnchoredModel(pos, rot) {
  const group = new THREE.Group();
  group.position.set(pos.x, pos.y, pos.z);
  if (rot) group.quaternion.set(rot.x, rot.y, rot.z, rot.w);

  // 主体：立方体，底面贴地
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.18, 0.18),
    new THREE.MeshPhongMaterial({ color: 0x00e6c8, emissive: 0x003333, shininess: 90 })
  );
  cube.position.y = 0.09;
  cube.userData.spin = true;
  group.add(cube);

  // 落地圆环标记
  const markGeo = new THREE.RingGeometry(0.09, 0.12, 36);
  markGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  const mark = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({
    color: 0x00e6c8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45,
    depthTest: false,
  }));
  group.add(mark);

  scene.add(group);
  placeCount++;
  countEl.textContent = `已放置：${placeCount}`;
}

// ─── XR8 SLAM 管线 ────────────────────────────────────────────────────────────
XR8.addCameraPipelineModule(XR8.GlTextureRenderer.pipelineModule());

XR8.addCameraPipelineModule({
  name: 'slam-demo',

  // 摄像头和 SLAM 就绪后触发
  onStart({ canvas }) {
    initThree(canvas.width, canvas.height);
    loadingEl.classList.add('hide');
  },

  // 每帧收到 SLAM 数据
  onUpdate({ processCpuResult }) {
    const reality = processCpuResult?.reality;
    if (!reality) return;

    // 1. 同步 SLAM 输出的相机内参（投影矩阵）
    if (reality.intrinsics) {
      for (let i = 0; i < 16; i++) {
        camera.projectionMatrix.elements[i] = reality.intrinsics[i];
      }
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }

    // 2. 同步 SLAM 输出的相机外参（位姿）
    if (reality.rotation) {
      const { x, y, z, w } = reality.rotation;
      camera.quaternion.set(x, y, z, w);
    }
    if (reality.position) {
      const { x, y, z } = reality.position;
      camera.position.set(x, y, z);
    }

    // 3. 屏幕中心射线命中检测（优先平面 > 特征点）
    const hits = XR8.XrController.hitTest(
      0.5, 0.5,
      ['ESTIMATED_SURFACE', 'FEATURE_POINT']
    );
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

    // 4. 旋转动画（每帧）
    scene.traverse(obj => {
      if (obj.userData.spin) obj.rotation.y += 0.012;
    });
  },

  // 渲染 Three.js 场景
  onRender() {
    if (renderer) renderer.render(scene, camera);
  },

  // 画布尺寸变化时同步
  onCanvasSizeChange({ canvasWidth, canvasHeight }) {
    if (!renderer) return;
    renderer.setSize(canvasWidth, canvasHeight, false);
    camera.aspect = canvasWidth / canvasHeight;
    camera.updateProjectionMatrix();
  },
});

// ─── 触摸放置：锚定在 SLAM hitTest 命中的世界坐标 ────────────────────────────
window.addEventListener('touchstart', e => {
  if (!canPlace) return;
  e.preventDefault();

  const t = e.touches[0];
  const nx = t.clientX / window.innerWidth;
  const ny = t.clientY / window.innerHeight;

  const hits = XR8.XrController.hitTest(nx, ny, ['ESTIMATED_SURFACE', 'FEATURE_POINT']);
  if (hits && hits.length) {
    placeAnchoredModel(hits[0].position, hits[0].rotation);
  }
}, { passive: false });

// ─── 启动 XR8 SLAM ────────────────────────────────────────────────────────────
XR8.run({ canvas: xrCanvas });
