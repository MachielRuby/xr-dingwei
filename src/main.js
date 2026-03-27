/**
 * 产品级 XR SLAM 空间定位 · 8th Wall + Three.js
 * 功能：平面识别 · 稳定锚点 · 不漂移 · 秒出瞄准环 · 产品级体验
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const xrCanvas = document.getElementById('xr-canvas');
const tipEl = document.getElementById('tip');
const countEl = document.getElementById('count');
const loadingEl = document.getElementById('loading');

const MODEL_SCALE = 1.0;

let scene, camera, renderer, reticle;
let canPlace = false;
let hasPlaced = false;
let _hasRecentered = false;
let glbTemplate = null;

// 锚点系统（产品级防漂移）
let _anchorId = null;
let _anchorGroup = null;
let _lastHit = null;

const _retPos = new THREE.Vector3();
const _retQuat = new THREE.Quaternion();
let _retReady = false;

// ————————————————————————————————————————
// 模型加载
// ————————————————————————————————————————
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

      const box = new THREE.Box3().setFromObject(glbTemplate);
      glbTemplate.position.y = -box.min.y;

      glbTemplate.traverse(child => {
        if (child.isMesh) {
          child.frustumCulled = false;
          child.material.side = THREE.DoubleSide;
        }
      });
    },
    undefined,
    err => console.error('模型加载失败', err)
  );
}

// ————————————————————————————————————————
// Three.js 初始化
// ————————————————————————————————————————
function initThree(canvas, glContext, w, h) {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
  camera.matrixAutoUpdate = false;

  renderer = new THREE.WebGLRenderer({ canvas, context: glContext, alpha: true, antialias: true });
  renderer.setSize(w, h, false);
  renderer.autoClear = false;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.physicallyCorrectLights = true;

  scene.add(new THREE.HemisphereLight(0xddeeff, 0x806040, 2.5));
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(5, 10, 7);
  scene.add(sun);

  // 瞄准环
  const ringGeo = new THREE.RingGeometry(0.04, 0.06, 48);
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  reticle = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0x00e6c8, transparent: true, opacity: 0.9, depthTest: false
  }));
  reticle.visible = false;
  reticle.renderOrder = 999;
  reticle.frustumCulled = false;
  scene.add(reticle);

  loadModel();
}

// ————————————————————————————————————————
// 创建模型组（产品级）
// ————————————————————————————————————————
function createModelGroup() {
  const group = new THREE.Group();
  const model = glbTemplate ? glbTemplate.clone() : new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.15, 0.15),
    new THREE.MeshPhongMaterial({ color: 0x00e6c8 })
  );
  group.add(model);
  scene.add(group);
  return group;
}

// ————————————————————————————————————————
// 点击放置（产品级锚点）
// ————————————————————————————————————————
function tryPlace() {
  if (hasPlaced || !canPlace || !_lastHit) return;
  hasPlaced = true;

  if (XR8.XrController.addAnchorAtHit) {
    const anchor = XR8.XrController.addAnchorAtHit(_lastHit);
    _anchorId = anchor.id;
    _anchorGroup = createModelGroup();
  } else {
    _anchorGroup = createModelGroup();
    _anchorGroup.position.copy(_retPos);
    _anchorGroup.quaternion.copy(_retQuat);
  }

  reticle.visible = false;
  tipEl.textContent = '✓ 模型已放置';
}

// ————————————————————————————————————————
// XR 启动
// ————————————————————————————————————————
const onXRLoad = async () => {
  try {
    await XR8.loadChunk('slam');
  } catch (e) {
    loadingEl.innerHTML = '⚠️ SLAM 加载失败';
    return;
  }

  XR8.addCameraPipelineModule(XR8.GlTextureRenderer.pipelineModule());
  XR8.addCameraPipelineModule(XR8.XrController.pipelineModule());

  XR8.addCameraPipelineModule({
    name: 'ar-pro',
    onStart({ canvas, canvasWidth, canvasHeight, GLctx }) {
      initThree(canvas, GLctx, canvasWidth, canvasHeight);
      loadingEl.classList.add('hide');
    },

    onUpdate({ processCpuResult }) {
      const reality = processCpuResult.reality;
      if (!reality) return;

      // 同步相机
      if (reality.intrinsics) camera.projectionMatrix.fromArray(reality.intrinsics);
      if (reality.position) camera.position.set(reality.position.x, reality.position.y, reality.position.z);
      if (reality.rotation) camera.quaternion.set(reality.rotation.x, reality.rotation.y, reality.rotation.z, reality.rotation.w);
      camera.updateMatrix();
      camera.updateMatrixWorld(true);

      // 模型已放置 → 同步锚点（防漂移核心）
      if (hasPlaced) {
        if (_anchorId && reality.anchors) {
          const a = reality.anchors.find(x => x.id === _anchorId);
          if (a) {
            _anchorGroup.position.copy(a.position);
            _anchorGroup.quaternion.copy(a.rotation);
          }
        }
        tipEl.style.color = reality.trackingStatus === 'NORMAL' ? '' : '#ff6b6b';
        tipEl.textContent = reality.trackingStatus === 'NORMAL' ? '✓ 追踪正常' : '⚠️ 追踪丢失，缓慢移动';
        return;
      }

      // 未初始化完成
      if (reality.trackingStatus !== 'NORMAL') {
        reticle.visible = false;
        tipEl.textContent = '请缓慢移动手机，初始化空间定位';
        return;
      }

      // 首次归中
      if (!_hasRecentered) {
        _hasRecentered = true;
        XR8.XrController.recenterXrOrigin?.();
        return;
      }

      // ————————————————————————————————————————
      // 🔥 产品级 hitTest（平衡速度 + 稳定性）
      // ————————————————————————————————————————
      let hits = XR8.XrController.hitTest(0.5, 0.5, ['PLANE', 'ESTIMATED_SURFACE']);

      // 无平面 → 使用特征点兜底（高度过滤，不飘）
      if (!hits?.length) {
        const fp = XR8.XrController.hitTest(0.5, 0.5, ['FEATURE_POINT']);
        if (fp?.length) {
          const camY = camera.position.y;
          hits = fp.filter(h => {
            const d = camY - h.position.y;
            return d > 0.3 && d < 1.6;
          });
        }
      }

      canPlace = hits?.length > 0;
      if (canPlace) {
        const { position, rotation } = hits[0];
        _lastHit = hits[0];

        _retPos.lerp(position, 0.15);
        _retQuat.slerp(rotation, 0.15);
        reticle.position.copy(_retPos);
        reticle.quaternion.copy(_retQuat);
        reticle.visible = true;
        tipEl.textContent = '✓ 点击放置模型';
      } else {
        reticle.visible = false;
        tipEl.textContent = '扫描地面中...';
      }
    },

    onRender() {
      renderer.clearDepth();
      renderer.render(scene, camera);
    },

    onCanvasSizeChange({ canvasWidth, canvasHeight }) {
      renderer.setSize(canvasWidth, canvasHeight, false);
    }
  });

  window.addEventListener('touchstart', e => { e.preventDefault(); tryPlace(); });
  window.addEventListener('click', tryPlace);

  XR8.run({
    canvas: xrCanvas,
    cameraConfig: { direction: XR8.XrConfig.camera().BACK }
  });
};

window.XR8 ? onXRLoad() : window.addEventListener('xrloaded', onXRLoad);