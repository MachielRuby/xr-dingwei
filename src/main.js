/**
 * XR SLAM 空间定位
 * 产品级稳定版 · 保留你原有全部逻辑 · 只修复平面检测
 */
import * as THREE from 'three';
import { GLTFLoader }  from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const xrCanvas  = document.getElementById('xr-canvas');
const tipEl     = document.getElementById('tip');
const countEl   = document.getElementById('count');
const loadingEl = document.getElementById('loading');

const MODEL_SCALE = 1.0;

let scene, camera, renderer, reticle;
let canPlace       = false;
let hasPlaced      = false;
let _hasRecentered = false;
let glbTemplate = null;
let _debugTimer = 0;
let hasLoggedReality = false;
let placeCount = 0;

let _anchorId    = null;
let _anchorGroup = null;
let _lastHit     = null;

const _retPos  = new THREE.Vector3();
const _retQuat = new THREE.Quaternion();
let   _retReady = false;

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
      glbTemplate.scale.setScalar(MODEL_SCALE);

      const box  = new THREE.Box3().setFromObject(glbTemplate);
      const size = box.getSize(new THREE.Vector3());
      glbTemplate.position.y = -box.min.y;

      glbTemplate.traverse(child => {
        if (child.isMesh) {
          child.castShadow    = true;
          child.receiveShadow = true;
          child.frustumCulled = false;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => {
            if (mat) {
              mat.side = THREE.DoubleSide;
              mat.needsUpdate = true;
            }
          });
        }
      });
    },
    undefined,
    (err) => console.error('[MODEL] Failed to load 01.glb:', err)
  );
}

// ─── Three.js 初始化 ─────────────────────────────────────────────────────────
function initThree(canvas, glContext, w, h) {
  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
  camera.matrixAutoUpdate = false;

  renderer = new THREE.WebGLRenderer({
    canvas, context: glContext, alpha: true, antialias: true,
  });
  renderer.autoClear = false;
  renderer.setSize(w, h, false);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.physicallyCorrectLights = true;

  const hemi = new THREE.HemisphereLight(0xddeeff, 0x806040, 2.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.position.set(5, 10, 7);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-5, 3, -4);
  scene.add(fill);

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

  loadModel();
}

// ─── 创建模型组 ──────────────────────────────────────────────────────────────
function createModelGroup() {
  let model;
  if (glbTemplate) {
    model = glbTemplate.clone();
  } else {
    model = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.15, 0.15),
      new THREE.MeshPhongMaterial({ color: 0x00e6c8 })
    );
    model.position.y = 0.075;
  }
  const group = new THREE.Group();
  group.add(model);
  scene.add(group);
  return group;
}

// ─── 放置模型 ────────────────────────────────────────────────────────────────
function tryPlace() {
  if (hasPlaced || !canPlace || !_retReady || !_lastHit) {
    return;
  }
  hasPlaced = true;

  if (XR8.XrController.addAnchorAtHit) {
    const result = XR8.XrController.addAnchorAtHit(_lastHit);
    _anchorId = result.id;
    _anchorGroup = createModelGroup();
  } else {
    _anchorGroup = createModelGroup();
    _anchorGroup.position.copy(_retPos);
    _anchorGroup.quaternion.copy(_retQuat);
  }

  reticle.visible = false;
  canPlace = false;
  tipEl.textContent = '✓ 模型已锚定';
  countEl.style.display = 'none';
}

// ─── XR 启动 ─────────────────────────────────────────────────────────────────
const onXRLoad = async () => {
  try {
    await XR8.loadChunk('slam');
  } catch (e) {
    loadingEl.querySelector('span').textContent = '⚠️ SLAM 加载失败';
    return;
  }

  XR8.addCameraPipelineModule(XR8.GlTextureRenderer.pipelineModule());
  XR8.addCameraPipelineModule(XR8.XrController.pipelineModule());

  XR8.addCameraPipelineModule({
    name: 'slam-demo',
    onStart({ canvas, canvasWidth, canvasHeight, GLctx }) {
      initThree(canvas, GLctx, canvasWidth, canvasHeight);
      loadingEl.classList.add('hide');
    },

    onUpdate({ processCpuResult }) {
      const reality = processCpuResult?.reality;
      if (!reality) return;

      // 同步相机
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

      // 已放置：同步锚点
      if (hasPlaced) {
        if (_anchorId && reality.anchors && _anchorGroup) {
          const a = reality.anchors.find(x => x.id === _anchorId);
          if (a) {
            _anchorGroup.position.copy(a.position);
            _anchorGroup.quaternion.copy(a.rotation);
          }
        }
        tipEl.style.color = reality.trackingStatus === 'NORMAL' ? '' : '#ff6b6b';
        tipEl.textContent = reality.trackingStatus === 'NORMAL' ? '✓ 模型已锚定' : '⚠️ 追踪丢失，请缓慢扫描环境';
        return;
      }

      // 追踪未正常 → 不显示
      if (reality.trackingStatus !== 'NORMAL') {
        reticle.visible = false;
        canPlace = false;
        tipEl.textContent = '移动手机缓慢扫描地面以初始化空间定位...';
        return;
      }

      // 首次归中
      if (!_hasRecentered) {
        _hasRecentered = true;
        XR8.XrController.recenterXrOrigin?.();
        _retReady = false;
        return;
      }

      // ===================== 核心修复：产品级稳定 hitTest =====================
      if (XR8.XrController.hitTest) {
        let hits = null;

        // 优先平面（最稳）
        hits = XR8.XrController.hitTest(0.5, 0.5, ['PLANE', 'ESTIMATED_SURFACE']);

        // 找不到 → 用特征点（安全过滤）
        if (!hits || hits.length === 0) {
          const fpHits = XR8.XrController.hitTest(0.5, 0.5, ['FEATURE_POINT']);
          if (fpHits && fpHits.length > 0) {
            const camY = camera.position.y;
            hits = fpHits.filter(h => {
              const d = camY - h.position.y;
              return d > 0.3 && d < 1.6;
            });
          }
        }

        canPlace = !!(hits && hits.length);

        if (canPlace) {
          const { position: p, rotation: q } = hits[0];
          _lastHit = hits[0];

          const t = _retReady ? 0.15 : 1;
          _retPos.lerp(new THREE.Vector3(p.x, p.y, p.z), t);
          reticle.position.copy(_retPos);

          if (q) {
            _retQuat.slerp(new THREE.Quaternion(q.x, q.y, q.z, q.w), t);
            reticle.quaternion.copy(_retQuat);
          }

          _retReady = true;
          tipEl.textContent = '✓ 检测到平面，点击放置模型';
        } else {
          tipEl.textContent = '对准地面，缓慢移动手机扫描平面...';
        }

        reticle.visible = canPlace;
      }
    },

    onRender() {
      if (!renderer) return;
      renderer.clearDepth();
      renderer.render(scene, camera);
    },

    onCanvasSizeChange({ canvasWidth, canvasHeight }) {
      renderer.setSize(canvasWidth, canvasHeight, false);
    },
  });

  window.addEventListener('touchstart', (e) => { e.preventDefault(); tryPlace(); }, { passive: false });
  window.addEventListener('click', tryPlace);

  XR8.run({
    canvas: xrCanvas,
    allowedDevices: XR8.XrConfig.device().ANY,
    cameraConfig: { direction: XR8.XrConfig.camera().BACK },
  });
};

window.XR8 ? onXRLoad() : window.addEventListener('xrloaded', onXRLoad);