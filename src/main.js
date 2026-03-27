/**
 * XR SLAM 空间定位
 * - 自动放置模型（首次 hitTest 成功即放）
 * - 手指拖拽可在空间中移动模型
 * - 松手后模型固定在世界坐标，SLAM 保持定位
 */
import * as THREE from 'three';
import { GLTFLoader }    from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/examples/jsm/loaders/DRACOLoader.js';
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils.js';

const xrCanvas  = document.getElementById('xr-canvas');
const tipEl     = document.getElementById('tip');
const countEl   = document.getElementById('count');
const loadingEl = document.getElementById('loading');

const MODEL_SCALE = 0.25;

let scene, camera, renderer;
let hasPlaced  = false;
let hasLoggedReality = false;
let glbTemplate = null;
let _debugTimer = 0;

// 动画相关
const _clock   = new THREE.Clock();
const _mixers  = [];
let _placedModel = null;
let _placedAnchor = null;  // 模型的锚点 Group
let placeCount = 0;

// ─── 拖拽状态 ──────────────────────────────────────────────────────────────
let _isDragging  = false;
let _touchStartX = 0;
let _touchStartY = 0;
const DRAG_THRESHOLD = 8; // px，区分点击和拖拽
let _dragConfirmed = false;

// 命中测试采样点（屏幕归一化坐标），从常用中心到底部区域逐步尝试
const HIT_TEST_POINTS = [
  [0.5, 0.5],
  [0.5, 0.62],
  [0.5, 0.75],
  [0.35, 0.65],
  [0.65, 0.65],
];

// ─── 加载 GLB 模型 ───────────────────────────────────────────────────────────
function loadModel() {
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  gltfLoader.load(
    '/01.glb',
    (gltf) => {
      glbTemplate = gltf.scene;
      glbTemplate.userData.animations = gltf.animations;
      console.log('[MODEL] animations:', gltf.animations.length, gltf.animations.map(a => a.name));

      glbTemplate.scale.setScalar(MODEL_SCALE);

      // 底面贴地：计算缩放后的包围盒，把底部对齐 y=0
      const box  = new THREE.Box3().setFromObject(glbTemplate);
      const size = box.getSize(new THREE.Vector3());
      glbTemplate.position.y = -box.min.y;

      // 遍历所有 Mesh：DoubleSide 允许从内部看到面，关闭 frustumCulled 防止进入模型后消失
      glbTemplate.traverse(child => {
        if (child.isMesh) {
          child.castShadow    = true;
          child.receiveShadow = true;
          child.frustumCulled = false;  // 在模型内部时不被视锥剔除
          // 处理单材质和多材质数组
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => {
            if (mat) {
              mat.side = THREE.DoubleSide;  // 双面渲染，站在内部也能看见面
              mat.needsUpdate = true;
            }
          });
        }
      });

      console.log('[MODEL] size(m):', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2),
        '(scale =', MODEL_SCALE, ')  → 如模型太大/太小请调整顶部 MODEL_SCALE');
    },
    undefined,
    (err) => console.error('[MODEL] Failed to load 01.glb:', err)
  );
}

function initThree(canvas, glContext, w, h) {
  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
  camera.matrixAutoUpdate = false;

  renderer = new THREE.WebGLRenderer({
    canvas,
    context: glContext,
    alpha: true,
    antialias: true,
  });
  renderer.autoClear = false;
  renderer.setSize(w, h, false);
  // PBR 必须项：正确的色彩空间 + 物理光照
  renderer.outputEncoding       = THREE.sRGBEncoding;
  renderer.physicallyCorrectLights = true;

  const hemi = new THREE.HemisphereLight(0xddeeff, 0x806040, 2.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.position.set(5, 10, 7);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-5, 3, -4);
  scene.add(fill);

  // 开始加载 GLB 模型
  loadModel();

  console.log('[INIT] Three.js ready:', w, 'x', h);
}

// ─── 放置模型 ────────────────────────────────────────────────────────────────
function placeModel(pos, rot) {
  let model;
  if (glbTemplate) {
    model = SkeletonUtils.clone(glbTemplate);  // 骨骼动画必须用 SkeletonUtils.clone
  } else {
    // GLB 还没加载完，用临时方块
    model = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.15, 0.15),
      new THREE.MeshPhongMaterial({ color: 0x00e6c8 })
    );
    model.position.y = 0.075;
  }

  const anchor = new THREE.Group();
  anchor.position.set(pos.x, pos.y, pos.z);
  if (rot) anchor.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  anchor.add(model);
  scene.add(anchor);
  _placedModel  = model;
  _placedAnchor = anchor;
  if (glbTemplate?.userData.animations?.length) {
    const mixer = new THREE.AnimationMixer(model);
    _mixers.push(mixer);
    console.log('[ANIM] Mixer created, animations:', glbTemplate.userData.animations.length);
  }

  placeCount++;
  countEl.textContent = `已放置：${placeCount}`;
  console.log('[PLACE]', pos);
}
function tryPlace() {
  if (hasPlaced || !canPlace || !_retReady) {
    console.log('[PLACE] skip: hasPlaced=', hasPlaced, 'canPlace=', canPlace, '_retReady=', _retReady);
    return;
  }
  hasPlaced = true;  // ★ 立即锁定，禁止再次放置

  // 直接取瞄准环的世界坐标放置
  placeModel(
    { x: _retPos.x, y: _retPos.y, z: _retPos.z },
    { x: _retQuat.x, y: _retQuat.y, z: _retQuat.z, w: _retQuat.w }
  );

  // 放置后：隐藏瞄准环、更新提示
  reticle.visible = false;
  canPlace = false;
  tipEl.textContent = '✓ 模型已锚定';
  countEl.style.display = 'none';
  console.log('[PLACE] Model anchored at', _retPos);
}

// ─── 点击已放置的模型播放动画 ─────────────────────────────────────────────────
function tryPlayAnimation(clientX, clientY) {
  if (!_placedModel || !_mixers.length || !glbTemplate?.userData.animations?.length) return;

  // 射线检测是否点中模型
  const ndcX = (clientX / window.innerWidth)  *  2 - 1;
  const ndcY = (clientY / window.innerHeight) * -2 + 1;
  const ray  = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  if (!ray.intersectObject(_placedModel, true).length) return;

  // 重置并播放第一个动画（循环）
  const mixer  = _mixers[0];
  const clip   = glbTemplate.userData.animations[0];
  const action = mixer.clipAction(clip);
  action.reset();
  action.loop = THREE.LoopRepeat;
  action.play();
  tipEl.textContent = '▶ 动画播放中';
  console.log('[ANIM] Playing:', clip.name);
}

function getPlacementHit() {
  const hitTest = XR8.XrController?.hitTest;
  if (!hitTest) return null;

  // 优先平面，找不到再退化到特征点，提升“扫半天没反应”场景下的可用性
  const testModes = [
    ['ESTIMATED_SURFACE'],
    ['ESTIMATED_SURFACE', 'FEATURE_POINT'],
    ['FEATURE_POINT'],
  ];

  for (const modes of testModes) {
    for (const [x, y] of HIT_TEST_POINTS) {
      const hits = hitTest(x, y, modes);
      if (hits && hits.length) {
        return { hit: hits[0], sample: [x, y], modes };
      }
    }
  }

  return null;
}

// ─── 拖拽：将模型锚点移到触摸点的 hitTest 位置 ──────────────────────────────
function moveModelToTouch(clientX, clientY) {
  if (!_placedAnchor || !XR8.XrController?.hitTest) return;

  const nx = clientX / window.innerWidth;
  const ny = clientY / window.innerHeight;

  const testModes = [
    ['ESTIMATED_SURFACE'],
    ['ESTIMATED_SURFACE', 'FEATURE_POINT'],
    ['FEATURE_POINT'],
  ];

  for (const modes of testModes) {
    const hits = XR8.XrController.hitTest(nx, ny, modes);
    if (hits && hits.length) {
      const h = hits[0];
      _placedAnchor.position.set(h.position.x, h.position.y, h.position.z);
      return;
    }
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

  // ═══ 注册 Pipeline ═══

  XR8.addCameraPipelineModule(XR8.GlTextureRenderer.pipelineModule());
  XR8.addCameraPipelineModule(XR8.XrController.pipelineModule());

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
        console.log('[SLAM] trackingStatus:', reality.trackingStatus);
        console.log('[SLAM] Full reality sample:', JSON.stringify(reality).slice(0, 500));
      }

      // 每3秒输出一次调试信息
      _debugTimer++;
      if (_debugTimer % 180 === 0) {
        console.log('[DEBUG] reality:', !!reality,
          'status:', reality?.trackingStatus,
          'intrinsics:', !!reality?.intrinsics,
          'position:', reality?.position,
          'hitTest available:', !!XR8.XrController?.hitTest);
      }

      if (!reality) return;

      if (reality.intrinsics) {
        camera.projectionMatrix.fromArray(reality.intrinsics);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
      if (reality.rotation) {
        camera.quaternion.set(reality.rotation.x, reality.rotation.y, reality.rotation.z, reality.rotation.w);
      }
      if (reality.position) {
        camera.position.set(reality.position.x, reality.position.y, reality.position.z);
      }
      camera.updateMatrix();
      camera.updateMatrixWorld(true);

      const delta = _clock.getDelta();
      if (_mixers.length) _mixers.forEach(m => m.update(delta));

      // ─ 自动放置：首次 hitTest 成功 + 模型已加载 → 立即放 ─
      if (!hasPlaced && glbTemplate && XR8.XrController.hitTest) {
        const result = getPlacementHit();
        const hit = result?.hit;
        if (hit) {
          hasPlaced = true;
          placeModel(
            { x: hit.position.x, y: hit.position.y, z: hit.position.z },
            hit.rotation ? { x: hit.rotation.x, y: hit.rotation.y, z: hit.rotation.z, w: hit.rotation.w } : null
          );
          tipEl.textContent = '✓ 模型已放置，拖拽可移动';
          countEl.style.display = 'none';
        } else {
          tipEl.textContent = reality.trackingStatus === 'NORMAL'
            ? '对准地面，即将自动放置...'
            : `正在建图(${reality.trackingStatus || 'INIT'})，请缓慢扫地面...`;
        }
      }
    },

    onRender() {
      if (!renderer) return;
      renderer.clearDepth();
      renderer.render(scene, camera);
    },

    onCanvasSizeChange({ canvasWidth, canvasHeight }) {
      if (!renderer) return;
      renderer.setSize(canvasWidth, canvasHeight, false);
    },
  });

  // ─── 触摸事件：拖拽移动 + 点击播放动画 ─────────────────────────────────────
  window.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!hasPlaced) return;
    const t = e.touches[0];
    _isDragging    = true;
    _dragConfirmed = false;
    _touchStartX   = t.clientX;
    _touchStartY   = t.clientY;
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!_isDragging || !hasPlaced) return;
    const t = e.touches[0];

    if (!_dragConfirmed) {
      const dx = t.clientX - _touchStartX;
      const dy = t.clientY - _touchStartY;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      _dragConfirmed = true;
      tipEl.textContent = '拖拽中...';
    }

    moveModelToTouch(t.clientX, t.clientY);
  }, { passive: false });

  window.addEventListener('touchend', () => {
    if (!_isDragging) return;

    if (_dragConfirmed) {
      tipEl.textContent = '✓ 模型已固定，拖拽可移动';
      console.log('[DRAG] Model repositioned to',
        _placedAnchor?.position.x.toFixed(3),
        _placedAnchor?.position.y.toFixed(3),
        _placedAnchor?.position.z.toFixed(3));
    } else {
      tryPlayAnimation(_touchStartX, _touchStartY);
    }

    _isDragging    = false;
    _dragConfirmed = false;
  });

  window.addEventListener('click', (e) => {
    if (hasPlaced) tryPlayAnimation(e.clientX, e.clientY);
  });

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    xrCanvas.width  = Math.round(window.innerWidth * dpr);
    xrCanvas.height = Math.round(window.innerHeight * dpr);
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
