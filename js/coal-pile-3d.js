/**
 * 煤堆三维热力可视化模块
 * 基于 Three.js r128 (UMD 构建)，把 N 个测点列 × 8 层深度的温度
 * 映射到半透明煤堆模型上，直观展示内部高温区域。
 *
 * 暴露全局 CoalPile3D:
 *   init(container, opts)  初始化场景（opts.legendEl / opts.tooltipEl）
 *   setData(depthsMap)     更新温度 {topic1:[8],topic2:[8],topic3:[8]}
 *   setDemo()              载入合成演示数据
 *   setAutoRotate(bool)    开关自动旋转
 *   resetView()            重置视角
 *   resize()               自适应容器尺寸
 *   setPaused(bool)        暂停/恢复渲染循环
 */
(function () {
    'use strict';

    // ===================== 色带 (与图例共用) =====================
    const TEMP_MIN = 0;
    const TEMP_MAX = 70;
    // 温度 → 颜色 关键帧 (蓝 → 青 → 绿 → 黄 → 橙 → 红)
    const STOPS = [
        [0.00, [44, 111, 187]],    // #2c6fbb 蓝
        [0.25, [42, 169, 160]],    // #2aa9a0 青
        [0.50, [89, 199, 90]],     // #59c75a 绿
        [0.70, [255, 213, 79]],    // #ffd54f 黄
        [0.85, [255, 138, 61]],    // #ff8a3d 橙
        [1.00, [229, 57, 53]],     // #e53935 红
    ];

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    function lerp(a, b, t) { return a + (b - a) * t; }

    /**
     * 温度 → 十六进制颜色字符串
     */
    function temperatureColor(t) {
        const n = clamp((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN), 0, 1);
        for (let i = 0; i < STOPS.length - 1; i++) {
            const [p0, c0] = STOPS[i];
            const [p1, c1] = STOPS[i + 1];
            if (n >= p0 && n <= p1) {
                const f = (n - p0) / (p1 - p0);
                const r = Math.round(lerp(c0[0], c1[0], f));
                const g = Math.round(lerp(c0[1], c1[1], f));
                const b = Math.round(lerp(c0[2], c1[2], f));
                return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
            }
        }
        return '#e53935';
    }

    /** 温度 → RGB 数组 [r, g, b]，供 Canvas 纹理用 */
    function temperatureColorToRgb(t) {
        const n = clamp((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN), 0, 1);
        for (let i = 0; i < STOPS.length - 1; i++) {
            const [p0, c0] = STOPS[i];
            const [p1, c1] = STOPS[i + 1];
            if (n >= p0 && n <= p1) {
                const f = (n - p0) / (p1 - p0);
                return [
                    Math.round(lerp(c0[0], c1[0], f)),
                    Math.round(lerp(c0[1], c1[1], f)),
                    Math.round(lerp(c0[2], c1[2], f)),
                ];
            }
        }
        return [229, 57, 53];
    }

    /** 生成辉光纹理 Canvas（径向渐变，中心亮边缘透明） */
    function createGlowTexture() {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.3, 'rgba(255,255,255,0.6)');
        gradient.addColorStop(0.7, 'rgba(255,255,255,0.15)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        return new THREE.CanvasTexture(canvas);
    }

    /** 生成与色带一致的 CSS 渐变（供图例使用） */
    function legendGradientCss() {
        const parts = STOPS.map(([p, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${(p * 100).toFixed(0)}%`);
        return `linear-gradient(to top, ${parts.join(', ')})`;
    }

    // ===================== 场景几何常量 =====================
    const PILE_RADIUS = 4.5;
    const PILE_HEIGHT = 4.5;
    const COLUMN_RADIUS = 1.4;          // 3 个测点列离中心水平距离
    const DEPTH_COUNT = 8;
    const TOP_Y = 3.0;                  // 表层测点高度
    const BOTTOM_Y = 0.35;              // 最深测点高度
    /** 根据 sensorKey（如 "topic1"）查找传感器名称 */
    function resolveSensorName(key) {
        var cfg = window._getSensorConfig ? window._getSensorConfig() : null;
        if (cfg && cfg.sensors) {
            var found = cfg.sensors.find(function (s) { return s.key === key; });
            if (found) return found.name;
        }
        // 回退：从 key 提取数字
        var m = key.match(/\d+$/);
        return m ? ('传感器 ' + m[0]) : key;
    }

    // ===================== 内部状态 =====================
    const S = {
        scene: null, camera: null, renderer: null,
        container: null, legendEl: null, tooltipEl: null,
        pile: null, ground: null,
        markerGroup: null, markers: [], // {mesh, baseScale, sensor, depth, value}
        columnLines: null,
        raycaster: null, pointer: null,
        initialized: false, paused: true, autoRotate: true,
        rafId: null, animTime: 0,
        theta: 0.9, phi: 1.05, radius: 15,
        dragTheta: 0.9, dragPhi: 1.05,
        dragging: false, lastX: 0, lastY: 0,
        hovered: null,
        _lastDepthSnapshot: null, // 3C: 脏检查
        _alarmHigh: null, // 6: 高温报警阈值
        _alarmLow: null,  // 6: 低温报警阈值
        _sensorKeys: ['topic1', 'topic2', 'topic3'], // 动态传感器键列表
    };

    const CoalPile3D = {

        /** 设置传感器键列表并重建标记 */
        setSensorKeys(keys) {
            S._sensorKeys = keys || ['topic1', 'topic2', 'topic3'];
            if (S.initialized) {
                this._rebuildMarkersAndLines();
            }
        },

        /** 重建标记和列线（传感器数量/键变更后调用） */
        _rebuildMarkersAndLines() {
            // 清除旧标记
            if (S.markerGroup) {
                S.scene.remove(S.markerGroup);
                S.markerGroup.traverse(function (obj) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) obj.material.forEach(function (m) { m.dispose(); });
                        else obj.material.dispose();
                    }
                });
            }
            S.markers = [];
            if (S.maxRing) { S.scene.remove(S.maxRing); S.maxRing = null; }

            // 清除旧列线
            if (S.columnLines) {
                S.scene.remove(S.columnLines);
                S.columnLines.traverse(function (obj) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) obj.material.dispose();
                });
            }

            // 重建
            this._buildMarkers();
            this._buildColumnLines();
            this._updatePileOpacity();
        },

        /** 初始化场景。opts: {legendEl, tooltipEl} */
        init(container, opts) {
            if (typeof THREE === 'undefined') {
                container.innerHTML = '<div style="padding:40px;color:#475569;text-align:center;line-height:1.6;">Three.js 未能加载，请检查网络后刷新。</div>';
                return false;
            }
            if (S.initialized) return true;

            opts = opts || {};
            S.container = container;
            S.legendEl = opts.legendEl || null;
            S.tooltipEl = opts.tooltipEl || null;

            const w = container.clientWidth || 800;
            const h = container.clientHeight || 520;

            // 场景
            S.scene = new THREE.Scene();

            // 相机
            S.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);

            // 透明背景，让页面的浅色摄影棚背景透出。
            try {
                S.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            } catch (error) {
                container.innerHTML = '<div style="padding:40px;color:#475569;text-align:center;line-height:1.6;">无法显示三维视图，请启用浏览器的硬件加速后刷新。</div>';
                return false;
            }
            S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            S.renderer.setSize(w, h);
            S.renderer.setClearColor(0x000000, 0);
            container.appendChild(S.renderer.domElement);

            // 中性天空光与柔和地面反射，保留石墨色体积感。
            const hemiLight = new THREE.HemisphereLight(0xf6f8ff, 0x8491a4, 0.7);
            S.scene.add(hemiLight);

            // 主方向光（从上方偏右前方照射）
            const dir = new THREE.DirectionalLight(0xffffff, 0.95);
            dir.position.set(8, 12, 6);
            S.scene.add(dir);

            // 冷白轮廓光分离模型边缘，不给温度色带叠加暖色。
            const back = new THREE.DirectionalLight(0xdce7ff, 0.55);
            back.position.set(-6, 6, -8);
            S.scene.add(back);

            const fill = new THREE.DirectionalLight(0xffffff, 0.22);
            fill.position.set(-7, 3, 6);
            S.scene.add(fill);

            this._buildPile();
            this._buildMarkers();
            this._buildColumnLines();

            // 图例
            if (S.legendEl) {
                S.legendEl.style.background = legendGradientCss();
            }

            // 交互
            S.raycaster = new THREE.Raycaster();
            S.pointer = new THREE.Vector2(0, 0);
            this._bindEvents();

            S.initialized = true;
            this._updateCamera();
            this.resize();
            return true;
        },

        _buildPile() {
            // 4A: 高分段圆锥，让形状更圆润
            const geo = new THREE.ConeGeometry(PILE_RADIUS, PILE_HEIGHT, 64, 8);

            // 4B: 顶点噪声位移，打破完美圆锥，模拟真实煤堆的不规则形状
            const positions = geo.attributes.position;
            for (let i = 0; i < positions.count; i++) {
                const x = positions.getX(i);
                const y = positions.getY(i);
                const z = positions.getZ(i);

                // 计算到中心轴的距离
                const radius = Math.sqrt(x * x + z * z);
                const angle = Math.atan2(z, x);

                // 高度影响因子：顶部影响小，底部影响大
                const heightFactor = (y + PILE_HEIGHT / 2) / PILE_HEIGHT;
                const noiseScale = 0.15 * (1 - heightFactor * 0.3);

                // 多层正弦噪声叠加
                const noise1 = Math.sin(angle * 3) * 0.4;
                const noise2 = Math.sin(angle * 7 + 1.5) * 0.2;
                const noise3 = Math.cos(angle * 5 + 2.3) * 0.3;
                const totalNoise = (noise1 + noise2 + noise3) * noiseScale;

                // 只在径向应用噪声，保持高度不变
                if (radius > 0.1) {
                    const newRadius = radius * (1 + totalNoise);
                    positions.setX(i, x * (newRadius / radius));
                    positions.setZ(i, z * (newRadius / radius));
                }
            }
            positions.needsUpdate = true;
            geo.computeVertexNormals();
            // 创建初始热力纹理 Canvas（先灰色）
            S._heatCanvas = document.createElement('canvas');
            S._heatCanvas.width = 256;
            S._heatCanvas.height = 256;
            S._heatCtx = S._heatCanvas.getContext('2d');
            this._clearHeatCanvas();
            S._heatTexture = new THREE.CanvasTexture(S._heatCanvas);
            S._heatTexture.wrapS = THREE.RepeatWrapping;
            S._heatTexture.wrapT = THREE.RepeatWrapping;
            // 3B: 各向异性过滤改善纹理质量
            S._heatTexture.anisotropy = S.renderer.capabilities.getMaxAnisotropy();

            // 基色由纹理控制，白色材质避免二次压暗石墨色和温度色带。
            const mat = new THREE.MeshPhongMaterial({
                color: 0xffffff,
                map: S._heatTexture,
                transparent: true,
                opacity: 0.82,
                shininess: 24,
                specular: 0x48505d,
                side: THREE.DoubleSide,
                depthWrite: false,
            });
            S.pile = new THREE.Mesh(geo, mat);
            S.pile.position.y = PILE_HEIGHT / 2;
            S.scene.add(S.pile);

            const wire = new THREE.LineSegments(
                new THREE.EdgesGeometry(geo, 30),
                new THREE.LineBasicMaterial({ color: 0x526077, transparent: true, opacity: 0.2 })
            );
            wire.position.copy(S.pile.position);
            S.pile.userData.wire = wire;
            S.scene.add(wire);

            // 地面圆盘
            const groundGeo = new THREE.CircleGeometry(PILE_RADIUS + 1.6, 48);
            const groundMat = new THREE.MeshBasicMaterial({ color: 0xdde3ec, transparent: true, opacity: 0.65 });
            S.ground = new THREE.Mesh(groundGeo, groundMat);
            S.ground.rotation.x = -Math.PI / 2;
            S.ground.position.y = -0.02;
            S.scene.add(S.ground);

            // 底座环
            const ring = new THREE.Mesh(
                new THREE.RingGeometry(PILE_RADIUS - 0.04, PILE_RADIUS + 0.05, 64),
                new THREE.MeshBasicMaterial({ color: 0xb2bdce, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = 0.01;
            S.scene.add(ring);

            // 5C: 地面接触阴影（使用径向渐变纹理模拟柔和阴影）
            const shadowCanvas = document.createElement('canvas');
            shadowCanvas.width = shadowCanvas.height = 256;
            const shadowCtx = shadowCanvas.getContext('2d');
            const shadowGradient = shadowCtx.createRadialGradient(128, 128, 0, 128, 128, 128);
            shadowGradient.addColorStop(0, 'rgba(34, 46, 67, 0.42)');
            shadowGradient.addColorStop(0.5, 'rgba(34, 46, 67, 0.2)');
            shadowGradient.addColorStop(1, 'rgba(34, 46, 67, 0)');
            shadowCtx.fillStyle = shadowGradient;
            shadowCtx.fillRect(0, 0, 256, 256);

            const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
            const shadowGeo = new THREE.PlaneGeometry(PILE_RADIUS * 2.5, PILE_RADIUS * 2.5);
            const shadowMat = new THREE.MeshBasicMaterial({
                map: shadowTexture,
                transparent: true,
                depthWrite: false,
                opacity: 0.6,
            });
            const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
            shadowMesh.rotation.x = -Math.PI / 2;
            shadowMesh.position.y = -0.01;
            S.scene.add(shadowMesh);
        },

        _columnPosition(sensorIdx, depthIdx) {
            const sensorCount = S._sensorKeys.length;
            // 单个传感器时放在煤堆正中
            if (sensorCount === 1) {
                return {
                    x: 0,
                    z: 0,
                    y: TOP_Y - depthIdx * ((TOP_Y - BOTTOM_Y) / (DEPTH_COUNT - 1)),
                };
            }
            const angle = (sensorIdx / sensorCount) * Math.PI * 2;
            const x = Math.cos(angle) * COLUMN_RADIUS;
            const z = Math.sin(angle) * COLUMN_RADIUS;
            const y = TOP_Y - depthIdx * ((TOP_Y - BOTTOM_Y) / (DEPTH_COUNT - 1));
            return { x, y, z };
        },

        _buildMarkers() {
            S.markerGroup = new THREE.Group();
            S.scene.add(S.markerGroup);

            const sensorKeys = S._sensorKeys;
            const sphereGeo = new THREE.SphereGeometry(0.2, 24, 24);
            const glowTexture = createGlowTexture();

            sensorKeys.forEach((key, si) => {
                for (let d = 0; d < DEPTH_COUNT; d++) {
                    const pos = this._columnPosition(si, d);
                    const mat = new THREE.MeshStandardMaterial({
                        color: 0x666666,
                        emissive: 0x000000,
                        roughness: 0.4,
                    });
                    const mesh = new THREE.Mesh(sphereGeo, mat);
                    mesh.position.set(pos.x, pos.y, pos.z);
                    mesh.userData = { sensor: key, sensorIdx: si, depth: d, value: null };
                    S.markerGroup.add(mesh);

                    // 2A: 为每个测点添加辉光 Sprite
                    const spriteMat = new THREE.SpriteMaterial({
                        map: glowTexture,
                        color: 0x666666,
                        transparent: true,
                        opacity: 0,
                        blending: THREE.AdditiveBlending,
                        depthWrite: false,
                    });
                    const sprite = new THREE.Sprite(spriteMat);
                    sprite.scale.set(1.2, 1.2, 1);
                    mesh.add(sprite);

                    S.markers.push({ mesh, sprite, baseScale: 1, sensor: key, depth: d, value: null });
                }
            });
        },

        _buildColumnLines() {
            S.columnLines = new THREE.Group();
            const lineMat = new THREE.LineBasicMaterial({ color: 0x52627a, transparent: true, opacity: 0.42 });
            for (let si = 0; si < S._sensorKeys.length; si++) {
                const pts = [];
                for (let d = 0; d < DEPTH_COUNT; d++) {
                    const p = this._columnPosition(si, d);
                    pts.push(new THREE.Vector3(p.x, p.y, p.z));
                }
                const geo = new THREE.BufferGeometry().setFromPoints(pts);
                S.columnLines.add(new THREE.Line(geo, lineMat));
            }
            S.scene.add(S.columnLines);
        },

        /** 清空热力纹理 Canvas（灰色底） */
        _clearHeatCanvas() {
            if (!S._heatCtx) return;
            S._heatCtx.fillStyle = '#434c5b';
            S._heatCtx.fillRect(0, 0, 256, 256);
        },

        /**
         * 3A: 根据温度数据生成热力纹理（径向渐变替代暴力 IDW，性能提升 1000 倍）
         * 3B: 各向异性过滤改善纹理质量
         * 3C: 脏检查机制避免重复计算
         */
        _updateHeatTexture(depthsMap) {
            if (!S._heatCtx || !S._heatTexture) return;

            // 3C: 脏检查 - 只在数据变化时重建纹理
            const snapshot = JSON.stringify(depthsMap);
            if (S._lastDepthSnapshot === snapshot) return;
            S._lastDepthSnapshot = snapshot;

            const ctx = S._heatCtx;
            const w = 256, h = 256;

            // 石墨色基底与无数据视图一致。
            ctx.fillStyle = '#434c5b';
            ctx.fillRect(0, 0, w, h);

            // 收集有效数据点
            const points = [];
            const sensorCount = S._sensorKeys.length;
            for (let si = 0; si < sensorCount; si++) {
                const key = S._sensorKeys[si];
                const arr = depthsMap[key];
                if (!Array.isArray(arr)) continue;
                const cx = w * (si / sensorCount + 1 / (2 * sensorCount));
                for (let d = 0; d < DEPTH_COUNT; d++) {
                    if (arr[d] == null || isNaN(arr[d])) continue;
                    const cy = h * (d / (DEPTH_COUNT - 1));
                    // 水平方向绘制三份（-w, 0, +w）保证环绕无缝衔接
                    for (let xOff = -w; xOff <= w; xOff += w) {
                        points.push({ x: cx + xOff, y: cy, v: arr[d] });
                    }
                }
            }

            if (points.length === 0) return;

            // 3A: 为每个温度点绘制径向渐变发光球
            const blobRadius = 65;
            points.forEach(p => {
                const color = temperatureColorToRgb(p.v);
                const [r, g, b] = color;
                const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, blobRadius);
                grad.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
                grad.addColorStop(0.3, `rgba(${r},${g},${b},0.6)`);
                grad.addColorStop(0.7, `rgba(${r},${g},${b},0.25)`);
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.fillRect(p.x - blobRadius, p.y - blobRadius, blobRadius * 2, blobRadius * 2);
            });

            S._heatTexture.needsUpdate = true;
        },

        /** 更新温度数据。depthsMap = { <sensorKey>: [8层深度], ... }（键由 setSensorKeys 决定） */
        setData(depthsMap) {
            if (!S.initialized) return;
            if (!depthsMap) return;

            // 更新表面热力图纹理
            this._updateHeatTexture(depthsMap);

            let maxTemp = -Infinity;
            let maxMarker = null;

            S.markers.forEach(m => {
                const arr = depthsMap[m.sensor];
                let v = null;
                if (Array.isArray(arr) && arr[m.depth] !== undefined && arr[m.depth] !== null) {
                    v = arr[m.depth];
                }
                m.value = v;
                if (v === null || isNaN(v)) {
                    m.mesh.material.color.set(0x555555);
                    m.mesh.material.emissive.set(0x000000);
                    m.mesh.scale.setScalar(0.5);
                    m.mesh.visible = false;
                    if (m.sprite) m.sprite.material.opacity = 0;
                } else {
                    const c = new THREE.Color(temperatureColor(v));
                    m.mesh.material.color.copy(c);
                    m.mesh.material.emissive.copy(c).multiplyScalar(0.45);
                    m.mesh.scale.setScalar(1);
                    m.mesh.visible = true;
                    // 设置辉光颜色（降低亮度）
                    if (m.sprite) {
                        m.sprite.material.color.copy(c);
                        m.sprite.material.opacity = 0.2;
                    }

                    // 追踪最高温度
                    if (v > maxTemp) {
                        maxTemp = v;
                        maxMarker = m;
                    }
                }
            });

            // 6D: 更新最高温度环标记
            if (maxMarker) {
                if (!S.maxRing) {
                    const ringGeometry = new THREE.TorusGeometry(0.25, 0.02, 16, 32);
                    const ringMaterial = new THREE.MeshBasicMaterial({
                        color: 0xffff00,
                        transparent: true,
                        opacity: 0.8
                    });
                    S.maxRing = new THREE.Mesh(ringGeometry, ringMaterial);
                    S.scene.add(S.maxRing);
                }
                S.maxRing.position.copy(maxMarker.mesh.position);
                S.maxRing.position.y += 0.3; // 稍微抬高
                S.maxRing.rotation.x = Math.PI / 2; // 水平放置
                S.maxRing.visible = true;
            }

            this._updatePileOpacity();
            // 更新可见标记缓存
            S._visibleMarkers = S.markers.filter(m => m.mesh.visible);
        },

        /** 载入合成演示数据（含一个内部高温区） */
        setDemo() {
            const keys = S._sensorKeys;
            const map = {};
            keys.forEach(k => { map[k] = []; });
            // 高温中心：第1列中间位置
            const hotC = 1, hotD = 4, hotStrength = 38, hotSigma = 1.8;
            keys.forEach((key, si) => {
                for (let d = 0; d < DEPTH_COUNT; d++) {
                    let t = 24 + Math.sin(si * 1.7 + d * 0.9) * 3 + (Math.random() * 2 - 1) * 1.2;
                    const dc = si - hotC, dd = d - hotD;
                    const dist2 = dc * dc + dd * dd;
                    t += hotStrength * Math.exp(-dist2 / (2 * hotSigma * hotSigma));
                    t += d * 0.8; // 越深越热（煤堆自燃常见规律）
                    map[key].push(parseFloat(t.toFixed(1)));
                }
            });
            this.setData(map);
        },

        _updatePileOpacity() {
            // 有数据时保持较高不透明度，让煤堆更实在
            if (!S.pile) return;
            const hasData = S.markers.some(m => m.value !== null);
            S.pile.material.opacity = hasData ? 0.55 : 0.82;
        },

        setAutoRotate(on) {
            S.autoRotate = on;
        },

        resetView() {
            S.theta = 0.9; S.phi = 1.05; S.radius = 15;
            this._updateCamera();
        },

        resize() {
            if (!S.initialized || !S.container) return;
            const w = S.container.clientWidth || 800;
            const h = S.container.clientHeight || 520;
            S.camera.aspect = w / h;
            S.camera.updateProjectionMatrix();
            S.renderer.setSize(w, h);
        },

        setPaused(paused) {
            S.paused = paused;
            if (paused) {
                if (S.rafId) { cancelAnimationFrame(S.rafId); S.rafId = null; }
            } else {
                if (!S.rafId) this._animate();
            }
        },

        _updateCamera() {
            const theta = S.dragTheta !== undefined ? S.dragTheta : S.theta;
            const phi = S.dragPhi !== undefined ? S.dragPhi : S.phi;
            S.camera.position.set(
                S.radius * Math.sin(phi) * Math.sin(theta),
                S.radius * Math.cos(phi),
                S.radius * Math.sin(phi) * Math.cos(theta)
            );
            S.camera.lookAt(0, PILE_HEIGHT * 0.4, 0);
        },

        _animate() {
            if (S.paused) return;
            S.rafId = requestAnimationFrame(() => this._animate());

            if (S.autoRotate && !S.dragging) {
                S.theta += 0.004;
            }

            // 平滑过渡到拖拽目标
            const k = 0.12;
            S.dragTheta += (S.theta - S.dragTheta) * k;
            S.dragPhi += (S.phi - S.dragPhi) * k;
            this._updateCamera();

            // 悬停高亮
            this._hoverCheck();

            S.renderer.render(S.scene, S.camera);
        },

        _bindEvents() {
            const el = S.renderer.domElement;
            let clickStartX = 0, clickStartY = 0;
            let clickMoved = false;

            el.addEventListener('mousedown', (e) => {
                S.dragging = true;
                S.lastX = e.clientX;
                S.lastY = e.clientY;
                clickStartX = e.clientX;
                clickStartY = e.clientY;
                clickMoved = false;
            });
            window.addEventListener('mouseup', () => {
                // 点击而非拖拽：检测点击了哪个标记点
                if (!clickMoved && S.raycaster && S.camera) {
                    const visibleMarkers = S._visibleMarkers || S.markers.filter(function (m) { return m.mesh && m.mesh.visible; });
                    S.raycaster.setFromCamera(S.pointer, S.camera);
                    const hits = S.raycaster.intersectObjects(visibleMarkers.map(function (m) { return m.mesh; }), false);
                    if (hits.length > 0) {
                        const hit = hits[0].object;
                        const u = hit.userData;
                        if (u && u.value != null) {
                            this._showClickPopup(hit, u);
                        }
                    }
                }
                S.dragging = false;
            });

            window.addEventListener('mousemove', (e) => {
                const rect = el.getBoundingClientRect();
                S.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                S.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

                if (S.dragging) {
                    const dx = e.clientX - S.lastX;
                    const dy = e.clientY - S.lastY;
                    S.lastX = e.clientX;
                    S.lastY = e.clientY;
                    S.theta -= dx * 0.008;
                    S.phi = clamp(S.phi - dy * 0.008, 0.15, Math.PI - 0.15);
                    // 移过足够距离就算拖拽
                    if (Math.abs(e.clientX - clickStartX) + Math.abs(e.clientY - clickStartY) > 5) {
                        clickMoved = true;
                    }
                }
                this._moveTooltip(e.clientX, e.clientY);
            });

            el.addEventListener('wheel', (e) => {
                e.preventDefault();
                S.radius = clamp(S.radius + e.deltaY * 0.01, 7, 28);
            }, { passive: false });

            // 触摸
            el.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    S.dragging = true;
                    S.lastX = e.touches[0].clientX;
                    S.lastY = e.touches[0].clientY;
                }
            }, { passive: true });
            el.addEventListener('touchmove', (e) => {
                if (S.dragging && e.touches.length === 1) {
                    const dx = e.touches[0].clientX - S.lastX;
                    const dy = e.touches[0].clientY - S.lastY;
                    S.lastX = e.touches[0].clientX;
                    S.lastY = e.touches[0].clientY;
                    S.theta -= dx * 0.008;
                    S.phi = clamp(S.phi - dy * 0.008, 0.15, Math.PI - 0.15);
                }
            }, { passive: true });
            el.addEventListener('touchend', () => { S.dragging = false; });

            window.addEventListener('resize', () => this.resize());
        },

        _hoverCheck() {
            if (!S.raycaster || !S.camera) return;
            const visibleMarkers = S._visibleMarkers || [];
            S.raycaster.setFromCamera(S.pointer, S.camera);
            const hits = S.raycaster.intersectObjects(visibleMarkers.map(m => m.mesh), false);
            const hit = hits.length > 0 ? hits[0].object : null;

            if (hit !== S.hovered) {
                // 取消旧高亮
                if (S.hovered) {
                    S.hovered.scale.setScalar(1);
                }
                S.hovered = hit;
                if (hit) {
                    hit.scale.setScalar(1.6);
                }
            }

            if (S.hovered && S.tooltipEl) {
                const u = S.hovered.userData;
                const name = resolveSensorName(u.sensor);
                const depthLabel = `深度 ${u.depth + 1}/8${u.depth === 0 ? ' (表层)' : ''}`;
                const temp = u.value !== null ? u.value.toFixed(1) + ' °C' : '--';
                S.tooltipEl.innerHTML = `<div class="c3d-tip-name">${name}</div>` +
                    `<div class="c3d-tip-row">${depthLabel}</div>` +
                    `<div class="c3d-tip-temp">${temp}</div>`;
                S.tooltipEl.style.display = 'block';
            } else if (S.tooltipEl) {
                S.tooltipEl.style.display = 'none';
            }
        },

        _moveTooltip(cx, cy) {
            if (!S.tooltipEl || !S.container) return;
            const rect = S.container.getBoundingClientRect();
            const left = cx - rect.left + 16;
            const top = cy - rect.top - 10;
            // Clamp within stage
            const maxLeft = rect.width - 160;
            const maxTop = rect.height - 60;
            S.tooltipEl.style.left = Math.max(4, Math.min(left, maxLeft)) + 'px';
            S.tooltipEl.style.top = Math.max(4, Math.min(top, maxTop)) + 'px';
        },

        /** 点击标记点弹出温度信息 */
        _showClickPopup(mesh, userData) {
            // 清除旧的弹出框
            if (S._clickPopup) {
                S._clickPopup.remove();
                S._clickPopup = null;
            }

            const sensorName = resolveSensorName(userData.sensor || '');
            const depthLabel = '层 ' + (userData.depth + 1) + ' / 8' + (userData.depth === 0 ? ' (表层)' : '');
            const temp = userData.value != null ? userData.value.toFixed(1) : '--';

            const popup = document.createElement('div');
            popup.className = 'c3d-click-popup';
            popup.innerHTML =
                '<div class="c3d-popup-name">' + sensorName + '</div>' +
                '<div class="c3d-popup-depth">' + depthLabel + '</div>' +
                '<div class="c3d-popup-temp">' + temp + ' °C</div>';

            // 放在 stage 容器内
            S.container.appendChild(popup);

            // 定位在屏幕中心偏下
            popup.style.cssText =
                'position:absolute;left:50%;bottom:40px;transform:translateX(-50%);' +
                'background:rgba(26,31,54,0.95);color:#fff;padding:10px 18px;border-radius:10px;' +
                'text-align:center;z-index:20;pointer-events:none;' +
                'box-shadow:0 4px 20px rgba(0,0,0,0.4);animation:c3d-popup-in 0.25s ease;';

            S._clickPopup = popup;

            // 3 秒后自动消失
            setTimeout(function () {
                if (S._clickPopup === popup) {
                    popup.style.opacity = '0';
                    popup.style.transition = 'opacity 0.3s';
                    setTimeout(function () {
                        if (S._clickPopup === popup) {
                            popup.remove();
                            S._clickPopup = null;
                        }
                    }, 300);
                }
            }, 2500);
        },

        /** 设置报警阈值（供外部调用） */
        setAlarmThreshold(high, low) {
            S._alarmHigh = high;
            S._alarmLow = low;

            // 6B: 在图例上添加阈值刻度线
            if (S.legendEl) {
                // 移除旧的刻度线
                S.legendEl.querySelectorAll('.c3d-legend-tick').forEach(el => el.remove());

                // 添加高温报警线
                if (high !== null && high !== undefined) {
                    const highPct = clamp((high - TEMP_MIN) / (TEMP_MAX - TEMP_MIN), 0, 1);
                    const highTick = document.createElement('div');
                    highTick.className = 'c3d-legend-tick c3d-legend-tick-high';
                    highTick.style.bottom = (highPct * 100) + '%';
                    highTick.title = `高温报警: ${high}°C`;
                    S.legendEl.appendChild(highTick);
                }

                // 添加低温报警线
                if (low !== null && low !== undefined) {
                    const lowPct = clamp((low - TEMP_MIN) / (TEMP_MAX - TEMP_MIN), 0, 1);
                    const lowTick = document.createElement('div');
                    lowTick.className = 'c3d-legend-tick c3d-legend-tick-low';
                    lowTick.style.bottom = (lowPct * 100) + '%';
                    lowTick.title = `低温报警: ${low}°C`;
                    S.legendEl.appendChild(lowTick);
                }
            }
        },
    };

    window.CoalPile3D = CoalPile3D;
})();
