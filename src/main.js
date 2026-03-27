/**
 * XR SLAM 空间定位
 * - 用 npm three (r128) + GLTFLoader/DRACOLoader 加载 01.glb
 * - 相机矩阵完全由 SLAM 驱动 (matrixAutoUpdate = false)
 * - 只有 trackingStatus === NORMAL 时才显示瞄准环、允许放置
 */
import * as THREE from 'three';
import { GLTFLoader }    from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/examples/jsm/loaders/DRACOLoader.js';
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils.js';

const xrCanvas  = document.getElementById('xr-canvas');
const tipEl     = document.getElementById('tip');
const countEl   = document.getElementById('count');
const loadingEl = document.getElementById('loading');

const MODEL_SCALE = 1.0;

let scene, camera, renderer, reticle;
let canPlace   = false;
let hasPlaced  = false;   // ★ 只允许放置一次
let placeCount = 0;
let hasLoggedReality = false;
let glbTemplate = null;
let _debugTimer = 0;

// 瞄准环平滑插值
const _retPos  = new THREE.Vector3();
const _retQuat = new THREE.Quaternion();
let   _retReady = false;

// 动画相关
const _clock   = new THREE.Clock();
const _mixers  = [];
let _placedModel = null;

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

      // 统一缩放（Blender cm 导出需要 ×0.01 才是真实米单位）
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

// ─── Three.js 初始化（共享 XR8 的 WebGL 上下文） ─────────────────────────────
function initThree(canvas, glContext, w, h) {
  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
  // ★ 关键：禁止 Three.js 自动更新相机矩阵，全部由 SLAM 数据驱动
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

  // 半球光（天空蓝 + 地面暖色）— PBR 材质的基础环境光
  const hemi = new THREE.HemisphereLight(0xddeeff, 0x806040, 2.5);
  scene.add(hemi);
  // 主方向光（模拟太阳）
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.position.set(5, 10, 7);
  scene.add(sun);
  // 补光（防止背面全黑）
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-5, 3, -4);
  scene.add(fill);

  // 瞄准环：固定物理尺寸 0.3m 半径，近大远小是正常3D透视效果
  const ringGeo = new THREE.RingGeometry(0.04, 0.06, 48);
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  reticle = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0x00e6c8, side: THREE.DoubleSide,
    depthTest: false, transparent: true, opacity: 0.9,
  }));
  reticle.visible = false;
  reticle.renderOrder = 999;
  reticle.frustumCulled = false;
  scene.add(reticle);

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

  // 保存已放置的模型引用，用于点击触发动画
  _placedModel = model;

  // 若模型有动画，创建 Mixer（先不播放，等点击触发）
  if (glbTemplate?.userData.animations?.length) {
    const mixer = new THREE.AnimationMixer(model);
    _mixers.push(mixer);
    console.log('[ANIM] Mixer created, animations:', glbTemplate.userData.animations.length);
  }

  placeCount++;
  countEl.textContent = `已放置：${placeCount}`;
  console.log('[PLACE]', pos);
}

// ─── 触摸/点击放置（直接用瞄准环坐标，不重新做 hitTest）────────────────────
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

      // ★ 同步 SLAM 相机 → Three.js 相机（手动管理矩阵）
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
      // 手动更新世界矩阵（因为 matrixAutoUpdate = false）
      camera.updateMatrix();
      camera.updateMatrixWorld(true);

      // 每帧更新动画 Mixer
      const delta = _clock.getDelta();
      if (_mixers.length) _mixers.forEach(m => m.update(delta));

      // ─── 瞄准环 hitTest（已放置后跳过，节省资源）───
      if (hasPlaced) return;

      if (XR8.XrController.hitTest) {
        const hits = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE']);
        canPlace = !!(hits && hits.length);

        if (_debugTimer % 180 === 0) {
          console.log('[DEBUG] hitTest result:', hits?.length || 0, 'canPlace:', canPlace);
        }

        if (canPlace) {
          const { position: p, rotation: q } = hits[0];
          const t = _retReady ? 0.15 : 1;

          _retPos.lerp(new THREE.Vector3(p.x, p.y, p.z), t);
          reticle.position.copy(_retPos);

          if (q) {
            _retQuat.slerp(new THREE.Quaternion(q.x, q.y, q.z, q.w), t);
            reticle.quaternion.copy(_retQuat);
          }

          _retReady = true;
          tipEl.textContent = '✓ 点击放置模型';
        } else {
          tipEl.textContent = reality.trackingStatus === 'NORMAL'
            ? '对准平面...'
            : '移动手机缓慢扫描地面...';
        }
        reticle.visible = canPlace;
      } else {
        tipEl.textContent = '正在初始化SLAM...';
      }
    },

    onRender() {
      if (!renderer) return;
      renderer.clearDepth();
      renderer.render(scene, camera);
    },

    onCanvasSizeChange({ canvasWidth, canvasHeight }) {
      if (!renderer) return;
      // ★ 只更新渲染尺寸，不碰 projectionMatrix（由 SLAM 每帧提供）
      renderer.setSize(canvasWidth, canvasHeight, false);
    },
  });

  // 触摸：未放置时放置，已放置时触发动画
  window.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!hasPlaced) {
      tryPlace();
    } else {
      const t = e.touches[0];
      tryPlayAnimation(t.clientX, t.clientY);
    }
  }, { passive: false });

  // 鼠标点击（调试用）
  window.addEventListener('click', (e) => {
    if (!hasPlaced) { tryPlace(); }
    else { tryPlayAnimation(e.clientX, e.clientY); }
  });

  // ═══ 设置 canvas 缓冲区尺寸 ═══
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
