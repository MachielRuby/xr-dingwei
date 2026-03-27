/**
 * XR SLAM 空间定位 (终极稳定版)
 * - 自动放置：首次识别地面 (hitTest) 成功即自动放置模型
 * - 丝滑拖拽：引入 dragOffset 消除瞬间吸附的抖动；使用纯数学平面提升百倍性能
 * - 视觉反馈：拖拽时显示防穿模的绿色锚点光环 (Reticle)
 * - 交互反馈：点击模型播放内置动画
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
let glbTemplate = null;

// 动画相关
const _clock   = new THREE.Clock();
const _mixers  = [];
let _placedModel = null;
let _placedAnchor = null;  // 模型的锚点 Group
let placeCount = 0;

// ─── 摇杆状态 ────────────────────────────────────────────────────────────────
const JOYSTICK_RADIUS = 50;   // px，摇杆旋钮最大偏移半径
const MOVE_SPEED      = 1.5;  // m/s，XZ 平面移动速度（相机朝向相对）
const VERT_SPEED      = 0.8;  // m/s，Y 轴上下移动速度
const _joystick = { active: false, touchId: null, zoneX: 0, zoneY: 0, dx: 0, dy: 0 };
const _vertMove  = { up: false, down: false };

// ─── 拖拽与锚点光标相关 ──────────────────────────────────────────────────────
let dragReticle = null;
let dragPlane = new THREE.Plane(); // 隐形数学平面，用于丝滑拖拽
let dragOffset = new THREE.Vector3(); // 记录手指按下时与模型中心的偏移量，防止瞬移抖动

// ─── 触摸状态控制 ───────────────────────────────────────────────────────────
let _isDragging  = false;
let _touchStartX = 0;
let _touchStartY = 0;
const DRAG_THRESHOLD = 8; // px，滑动超过此距离算作拖拽，否则算作点击
let _dragConfirmed = false;

// 首次自动放置的检测采样点（屏幕归一化坐标）
const HIT_TEST_POINTS = [
  [0.5, 0.5],
  [0.5, 0.62],
  [0.5, 0.75],
  [0.35, 0.65],
  [0.65, 0.65],
];

// ─── 加载模型 ────────────────────────────────────────────────────────────────
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
      console.log('[MODEL] animations:', gltf.animations.length);

      glbTemplate.scale.setScalar(MODEL_SCALE);

      // 计算包围盒，确保模型底部对齐 Y=0 平面
      const box  = new THREE.Box3().setFromObject(glbTemplate);
      glbTemplate.position.y = -box.min.y;

      glbTemplate.traverse(child => {
        if (child.isMesh) {
          child.castShadow    = true;
          child.receiveShadow = true;
          child.frustumCulled = false;  // 防止进入模型内部时消失
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => {
            if (mat) {
              mat.side = THREE.DoubleSide; 
              mat.needsUpdate = true;
            }
          });
        }
      });
      console.log('[MODEL] Loaded successfully.');
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

  // 初始化拖拽光环 (Reticle)
  const ringGeo = new THREE.RingGeometry(0.15, 0.2, 32);
  ringGeo.rotateX(-Math.PI / 2); 
  const ringMat = new THREE.MeshBasicMaterial({ 
    color: 0x00ff00, 
    transparent: true, 
    opacity: 0.8
    // 注意：不再使用 depthTest: false，改用拖拽时主动抬高 Y 轴来防止穿模
  });
  dragReticle = new THREE.Mesh(ringGeo, ringMat);
  dragReticle.visible = false; 
  scene.add(dragReticle);

  loadModel();
}

// ─── 放置模型 (仅首次自动触发) ───────────────────────────────────────────────
function placeModel(pos, rot) {
  let model;
  if (glbTemplate) {
    model = SkeletonUtils.clone(glbTemplate);
  } else {
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
  }

  placeCount++;
  if(countEl) countEl.textContent = `已放置：${placeCount}`;

  // 模型放置后显示摇杆 UI
  document.getElementById('joystick-wrap')?.classList.add('visible');
  document.getElementById('vertical-btns')?.classList.add('visible');
}

// ─── 获取准确的标准化设备坐标 (NDC) ──────────────────────────────────────────
function getNormalizedDeviceCoordinates(clientX, clientY) {
  const rect = xrCanvas.getBoundingClientRect();
  return new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
}

// ─── 点击模型播放动画 ─────────────────────────────────────────────────────────
function tryPlayAnimation(clientX, clientY) {
  if (!_placedModel || !_mixers.length || !glbTemplate?.userData.animations?.length) return;

  const mouse = getNormalizedDeviceCoordinates(clientX, clientY);
  const raycaster  = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  
  if (!raycaster.intersectObject(_placedModel, true).length) return;

  const mixer  = _mixers[0];
  const clip   = glbTemplate.userData.animations[0];
  const action = mixer.clipAction(clip);
  action.reset();
  action.loop = THREE.LoopRepeat;
  action.play();
  if(tipEl) tipEl.textContent = '▶ 动画播放中';
}

// ─── 查找可放置的平面 ─────────────────────────────────────────────────────────
function getPlacementHit() {
  const hitTest = XR8.XrController?.hitTest;
  if (!hitTest) return null;

  const testModes = [
    ['ESTIMATED_SURFACE'],
    ['ESTIMATED_SURFACE', 'FEATURE_POINT'],
    ['FEATURE_POINT'],
  ];

  for (const modes of testModes) {
    for (const [x, y] of HIT_TEST_POINTS) {
      const hits = hitTest(x, y, modes);
      if (hits && hits.length) return hits[0];
    }
  }
  return null;
}

// ─── 核心：带 Offset 的丝滑拖拽 ───────────────────────────────────────────────
function moveModelSmoothly(clientX, clientY) {
  if (!_placedAnchor || !dragReticle) return;

  const mouse = getNormalizedDeviceCoordinates(clientX, clientY);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);

  const intersectPoint = new THREE.Vector3();
  raycaster.ray.intersectPlane(dragPlane, intersectPoint);

  if (intersectPoint) {
    // 补回按下瞬间计算出的偏移量，彻底消除“瞬间闪现”的抖动
    const targetPos = intersectPoint.clone().add(dragOffset);
    _placedAnchor.position.copy(targetPos);
    
    // 光环跟随模型中心，并主动抬高 1cm，防止与现实地面穿模不可见
    dragReticle.position.copy(targetPos);
    dragReticle.position.y += 0.01; 
  }
}

// ─── 每帧根据摇杆状态移动模型 ────────────────────────────────────────────────
function applyJoystickMovement(delta) {
  if (!_placedAnchor) return;
  const movingXZ = _joystick.active && (_joystick.dx !== 0 || _joystick.dy !== 0);
  if (!movingXZ && !_vertMove.up && !_vertMove.down) return;

  // 以相机水平朝向为基准，分解出前进方向和右方向（去除竖直分量）
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  forward.y = 0; forward.normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  right.y = 0; right.normalize();

  if (movingXZ) {
    const nx =  _joystick.dx / JOYSTICK_RADIUS; // -1~1，向右为正
    const ny =  _joystick.dy / JOYSTICK_RADIUS; // -1~1，向下为正
    _placedAnchor.position.addScaledVector(right,   nx * MOVE_SPEED * delta);
    _placedAnchor.position.addScaledVector(forward, -ny * MOVE_SPEED * delta); // 推杆向上 = 前进
  }
  if (_vertMove.up)   _placedAnchor.position.y += VERT_SPEED * delta;
  if (_vertMove.down) _placedAnchor.position.y -= VERT_SPEED * delta;
}

// ─── 8th Wall 启动与事件绑定 ─────────────────────────────────────────────────
const XR_TIMEOUT = 15000;
const xrTimer = setTimeout(() => {
  if(loadingEl) loadingEl.querySelector('span').textContent = '⚠️ AR 引擎加载超时';
}, XR_TIMEOUT);

const onXRLoad = async () => {
  clearTimeout(xrTimer);

  try {
    await XR8.loadChunk('slam');
  } catch (e) {
    if(loadingEl) loadingEl.querySelector('span').textContent = '⚠️ SLAM 模块加载失败';
    return;
  }

  XR8.addCameraPipelineModule(XR8.GlTextureRenderer.pipelineModule());
  XR8.addCameraPipelineModule(XR8.XrController.pipelineModule());

  XR8.addCameraPipelineModule({
    name: 'slam-demo',
    onStart({ canvas, canvasWidth, canvasHeight, GLctx }) {
      initThree(canvas, GLctx, canvasWidth, canvasHeight);
      if(loadingEl) loadingEl.classList.add('hide');
    },
    onUpdate({ processCpuResult }) {
      const reality = processCpuResult?.reality;
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
      applyJoystickMovement(delta);

      // 首次识别地面并自动放置
      if (!hasPlaced && glbTemplate && XR8.XrController.hitTest) {
        const hit = getPlacementHit();
        if (hit) {
          hasPlaced = true;
          placeModel(
            { x: hit.position.x, y: hit.position.y, z: hit.position.z },
            hit.rotation ? { x: hit.rotation.x, y: hit.rotation.y, z: hit.rotation.z, w: hit.rotation.w } : null
          );
          if(tipEl) tipEl.textContent = '✓ 模型已放置，长按拖拽可移动';
          if(countEl) countEl.style.display = 'none';
        } else if (tipEl) {
          tipEl.textContent = reality.trackingStatus === 'NORMAL'
            ? '对准地面，即将自动放置...'
            : `正在建图(${reality.trackingStatus || 'INIT'})，请缓慢移动...`;
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

  // ─── 触摸事件监听 ──────────────────────────────────────────────────────────
  window.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!hasPlaced || !_placedAnchor) return;
    const t = e.touches[0];
    _isDragging    = true;
    _dragConfirmed = false;
    _touchStartX   = t.clientX;
    _touchStartY   = t.clientY;

    // 1. 根据模型当前高度，定义拖拽用隐形平面
    const upVector = new THREE.Vector3(0, 1, 0);
    dragPlane.setFromNormalAndCoplanarPoint(upVector, _placedAnchor.position);

    // 2. 计算 Offset 偏移量，防止拖拽瞬间模型瞬移到手指正下方
    const mouse = getNormalizedDeviceCoordinates(t.clientX, t.clientY);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const hitPoint = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, hitPoint);
    
    if (hitPoint) {
      dragOffset.copy(_placedAnchor.position).sub(hitPoint);
    } else {
      dragOffset.set(0, 0, 0);
    }
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!_isDragging || !hasPlaced) return;
    const t = e.touches[0];

    // 判断是点击还是拖拽
    if (!_dragConfirmed) {
      const dx = t.clientX - _touchStartX;
      const dy = t.clientY - _touchStartY;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      
      _dragConfirmed = true;
      if (dragReticle) dragReticle.visible = true; // 确认拖拽，显示绿色光环
      if (tipEl) tipEl.textContent = '拖拽移动中...';
    }

    moveModelSmoothly(t.clientX, t.clientY);
  }, { passive: false });

  window.addEventListener('touchend', () => {
    if (!_isDragging) return;

    if (_dragConfirmed) {
      if (tipEl) tipEl.textContent = '✓ 模型位置已更新';
      if (dragReticle) dragReticle.visible = false; // 拖拽结束，隐藏光环
    } else {
      // 未达到拖拽阈值，视为点击，尝试播放动画
      tryPlayAnimation(_touchStartX, _touchStartY);
    }

    _isDragging    = false;
    _dragConfirmed = false;
  });

  // ─── 虚拟摇杆事件（左下角，控制 XZ 平面移动） ─────────────────────────────
  const joystickZone = document.getElementById('joystick-zone');
  const joystickKnob = document.getElementById('joystick-knob');
  if (joystickZone) {
    joystickZone.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (_joystick.active) return;
      const t = e.changedTouches[0];
      const rect = joystickZone.getBoundingClientRect();
      _joystick.active  = true;
      _joystick.touchId = t.identifier;
      _joystick.zoneX   = rect.left + rect.width  / 2;
      _joystick.zoneY   = rect.top  + rect.height / 2;
      _joystick.dx = 0;
      _joystick.dy = 0;
    }, { passive: false });

    joystickZone.addEventListener('touchmove', (e) => {
      e.preventDefault(); e.stopPropagation();
      for (const t of e.changedTouches) {
        if (t.identifier !== _joystick.touchId) continue;
        let dx = t.clientX - _joystick.zoneX;
        let dy = t.clientY - _joystick.zoneY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > JOYSTICK_RADIUS) { dx *= JOYSTICK_RADIUS / dist; dy *= JOYSTICK_RADIUS / dist; }
        _joystick.dx = dx;
        _joystick.dy = dy;
        if (joystickKnob) {
          joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        }
      }
    }, { passive: false });

    const resetJoystick = (e) => {
      e.preventDefault(); e.stopPropagation();
      for (const t of e.changedTouches) {
        if (t.identifier !== _joystick.touchId) continue;
        _joystick.active = false; _joystick.touchId = null;
        _joystick.dx = 0; _joystick.dy = 0;
        if (joystickKnob) joystickKnob.style.transform = 'translate(-50%, -50%)';
      }
    };
    joystickZone.addEventListener('touchend',    resetJoystick, { passive: false });
    joystickZone.addEventListener('touchcancel', resetJoystick, { passive: false });
  }

  // ─── 上下按钮（右下角，控制 Y 轴移动） ────────────────────────────────────
  const btnUp   = document.getElementById('btn-up');
  const btnDown = document.getElementById('btn-down');
  [btnUp, btnDown].forEach(btn => {
    // 阻止 touchstart 冒泡，防止意外触发窗口的拖拽逻辑
    btn?.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
  });
  if (btnUp) {
    btnUp.addEventListener('pointerdown',  () => { _vertMove.up = true;  });
    btnUp.addEventListener('pointerup',    () => { _vertMove.up = false; });
    btnUp.addEventListener('pointerleave', () => { _vertMove.up = false; });
  }
  if (btnDown) {
    btnDown.addEventListener('pointerdown',  () => { _vertMove.down = true;  });
    btnDown.addEventListener('pointerup',    () => { _vertMove.down = false; });
    btnDown.addEventListener('pointerleave', () => { _vertMove.down = false; });
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    xrCanvas.width  = Math.round(window.innerWidth * dpr);
    xrCanvas.height = Math.round(window.innerHeight * dpr);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  XR8.run({
    canvas: xrCanvas,
    allowedDevices: XR8.XrConfig.device().ANY,
    cameraConfig: { direction: XR8.XrConfig.camera().BACK },
  });
};

if (window.XR8) {
  onXRLoad();
} else {
  window.addEventListener('xrloaded', onXRLoad);
}