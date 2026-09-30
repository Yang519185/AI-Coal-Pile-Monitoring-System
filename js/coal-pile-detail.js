/**
 * 单传感器煤堆 3D 视图（工厂模式，支持多实例）
 * 单列 8 层深度的温度测点柱，带热力纹理和发光效果
 *
 * 暴露全局:
 *   createCoalPileDetail()      工厂函数，返回全新独立实例
 *
 * 实例方法:
 *   init(container, opts)       初始化场景
 *   setData(depths, name)       更新温度数据 depths[8]
 *   setDemo()                   载入演示数据
 *   destroy()                   销毁场景
 *   resize()                    适应容器尺寸
 *   setAutoRotate(bool)         开关自动旋转
 */
(function () {
    'use strict';

    // 色带（与主模块一致）
    const TEMP_MIN = 0, TEMP_MAX = 70;
    const STOPS = [
        [0.00, [44, 111, 187]],
        [0.25, [42, 169, 160]],
        [0.50, [89, 199, 90]],
        [0.70, [255, 213, 79]],
        [0.85, [255, 138, 61]],
        [1.00, [229, 57, 53]],
    ];
    const DEPTH_COUNT = 8, PILLAR_HEIGHT = 4, PILLAR_RADIUS = 1.2;
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function lerp(a, b, t) { return a + (b - a) * t; }

    function temperatureColor(t) {
        const n = clamp((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN), 0, 1);
        for (let i = 0; i < STOPS.length - 1; i++) {
            if (n >= STOPS[i][0] && n <= STOPS[i + 1][0]) {
                const f = (n - STOPS[i][0]) / (STOPS[i + 1][0] - STOPS[i][0]);
                const [c0, c1] = [STOPS[i][1], STOPS[i + 1][1]];
                return '#' + [0, 1, 2].map(j => Math.round(lerp(c0[j], c1[j], f)).toString(16).padStart(2, '0')).join('');
            }
        }
        return '#e53935';
    }

    function temperatureColorToRgb(t) {
        const n = clamp((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN), 0, 1);
        for (let i = 0; i < STOPS.length - 1; i++) {
            if (n >= STOPS[i][0] && n <= STOPS[i + 1][0]) {
                const f = (n - STOPS[i][0]) / (STOPS[i + 1][0] - STOPS[i][0]);
                const [c0, c1] = [STOPS[i][1], STOPS[i + 1][1]];
                return [0, 1, 2].map(j => Math.round(lerp(c0[j], c1[j], f)));
            }
        }
        return [229, 57, 53];
    }

    function createGlowTexture() {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
        g.addColorStop(0.7, 'rgba(255,255,255,0.1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return new THREE.CanvasTexture(canvas);
    }

    /**
     * 创建单个 CoalPileDetail 实例（工厂函数）
     * 每个实例维护独立的 Three.js 场景状态
     */
    function makeInstance() {
        const inst = {};

        function _S() { return inst._state; }

        inst.init = function (container, opts) {
            if (typeof THREE === 'undefined') {
                container.innerHTML = '<div style="padding:20px;color:#475569;text-align:center;line-height:1.6;">Three.js 未加载</div>';
                return false;
            }

            inst._destroy();
            inst._state = {
                container: container,
                sensorName: '',
                depths: [],
                markers: [],
                rafId: null,
                animTime: 0,
                autoRotate: (opts && opts.autoRotate !== undefined) ? opts.autoRotate : true,
                dragging: false,
                lastX: 0, lastY: 0,
                theta: 0.9, phi: 1.1, radius: 8,
                dragTheta: 0.9, dragPhi: 1.1,
                pointer: new THREE.Vector2(),
                raycaster: null,
                hovered: null,
            };

            const S = _S();
            const w = container.clientWidth || 400, h = container.clientHeight || 320;

            // Scene
            S.scene = new THREE.Scene();

            // Camera
            S.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 50);

            // Renderer
            try {
                S.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            } catch (error) {
                inst._destroy();
                container.innerHTML = '<div style="padding:20px;color:#475569;text-align:center;line-height:1.6;">无法显示三维视图，请启用浏览器的硬件加速后刷新。</div>';
                return false;
            }
            S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            S.renderer.setSize(w, h);
            S.renderer.setClearColor(0x000000, 0);
            container.appendChild(S.renderer.domElement);

            // Lighting
            S.scene.add(new THREE.HemisphereLight(0xf6f8ff, 0x8491a4, 0.7));
            const dir = new THREE.DirectionalLight(0xffffff, 0.95);
            dir.position.set(5, 8, 5);
            S.scene.add(dir);
            const rim = new THREE.DirectionalLight(0xdce7ff, 0.55);
            rim.position.set(-4, 5, -4);
            S.scene.add(rim);
            const fill = new THREE.DirectionalLight(0xffffff, 0.22);
            fill.position.set(-5, 3, 5);
            S.scene.add(fill);

            // Cylinder pillar
            const cylGeo = new THREE.CylinderGeometry(PILLAR_RADIUS, PILLAR_RADIUS, PILLAR_HEIGHT, 48, 8);

            // Generate heat texture canvas
            S.heatCanvas = document.createElement('canvas');
            S.heatCanvas.width = 128; S.heatCanvas.height = 256;
            S.heatCtx = S.heatCanvas.getContext('2d');
            S.heatCtx.fillStyle = '#434c5b';
            S.heatCtx.fillRect(0, 0, 128, 256);
            S.heatTexture = new THREE.CanvasTexture(S.heatCanvas);
            S.heatTexture.wrapS = THREE.RepeatWrapping;
            S.heatTexture.wrapT = THREE.RepeatWrapping;
            S.heatTexture.anisotropy = S.renderer.capabilities.getMaxAnisotropy();

            const mat = new THREE.MeshPhongMaterial({
                color: 0xffffff,
                map: S.heatTexture,
                transparent: true,
                opacity: 0.65,
                shininess: 24,
                specular: 0x48505d,
                depthWrite: true,
            });
            S.pillar = new THREE.Mesh(cylGeo, mat);
            S.pillar.position.y = PILLAR_HEIGHT / 2;
            S.scene.add(S.pillar);

            // Wireframe
            const wire = new THREE.LineSegments(
                new THREE.EdgesGeometry(cylGeo, 15),
                new THREE.LineBasicMaterial({ color: 0x526077, transparent: true, opacity: 0.2 })
            );
            wire.position.copy(S.pillar.position);
            S.scene.add(wire);

            // Ground
            const groundGeo = new THREE.CircleGeometry(PILLAR_RADIUS + 0.8, 32);
            const ground = new THREE.Mesh(groundGeo, new THREE.MeshBasicMaterial({ color: 0xdde3ec, transparent: true, opacity: 0.65 }));
            ground.rotation.x = -Math.PI / 2;
            ground.position.y = -0.02;
            S.scene.add(ground);

            S.groundShadowTexture = createGlowTexture();
            const shadow = new THREE.Mesh(
                new THREE.PlaneGeometry((PILLAR_RADIUS + 0.8) * 2, (PILLAR_RADIUS + 0.8) * 2),
                new THREE.MeshBasicMaterial({ map: S.groundShadowTexture, color: 0x222e43, transparent: true, opacity: 0.22, depthWrite: false })
            );
            shadow.rotation.x = -Math.PI / 2;
            shadow.position.y = -0.01;
            S.scene.add(shadow);

            // Markers (8 depth layers, single column at center)
            S.markerGroup = new THREE.Group();
            S.scene.add(S.markerGroup);

            const sphereGeo = new THREE.SphereGeometry(0.18, 20, 20);
            const glowTex = createGlowTexture();

            for (let d = 0; d < DEPTH_COUNT; d++) {
                const y = 3.0 - d * ((3.0 - 0.35) / (DEPTH_COUNT - 1));
                const mat2 = new THREE.MeshStandardMaterial({ color: 0x666666, emissive: 0x000000, roughness: 0.4 });
                const mesh = new THREE.Mesh(sphereGeo, mat2);
                mesh.position.set(0, y, PILLAR_RADIUS + 0.15);
                mesh.userData = { depth: d, value: null };
                S.markerGroup.add(mesh);

                const spriteMat = new THREE.SpriteMaterial({
                    map: glowTex, color: 0x666666, transparent: true, opacity: 0,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                });
                const sprite = new THREE.Sprite(spriteMat);
                sprite.scale.set(0.9, 0.9, 1);
                mesh.add(sprite);

                S.markers.push({ mesh, sprite, depth: d, value: null });
                S.raycaster = new THREE.Raycaster();
            }

            // Depth labels (only if wide enough)
            const div = document.createElement('div');
            div.className = 'detail-coal3d-labels';
            S.labelDiv = div;
            div.style.cssText = 'position:absolute;right:12px;top:14px;bottom:14px;display:flex;flex-direction:column;justify-content:space-between;font-size:10px;font-weight:500;color:#526077;pointer-events:none';
            for (let d = 0; d < DEPTH_COUNT; d++) {
                const span = document.createElement('span');
                span.textContent = `层${DEPTH_COUNT - d}`;
                div.appendChild(span);
            }
            container.style.position = 'relative';
            container.appendChild(div);

            // Interaction
            inst._bindEvents(S);

            // Start animation
            inst._updateCamera(S);
            inst._animate(S);
            return true;
        };

        inst.setData = function (depths, name) {
            const S = _S();
            if (!S || !S.scene) return;
            S.sensorName = name || '';
            S.depths = depths || [];

            // Update markers
            S.markers.forEach(function (m) {
                const v = (depths && depths[m.depth] != null && !isNaN(depths[m.depth])) ? depths[m.depth] : null;
                m.value = v;
                if (v == null) {
                    m.mesh.material.color.set(0x555555);
                    m.mesh.material.emissive.set(0x000000);
                    m.mesh.material.opacity = 0.4;
                    if (m.sprite) m.sprite.material.opacity = 0;
                } else {
                    const c = new THREE.Color(temperatureColor(v));
                    m.mesh.material.color.copy(c);
                    m.mesh.material.emissive.copy(c).multiplyScalar(0.35);
                    m.mesh.material.opacity = 1;
                    if (m.sprite) { m.sprite.material.color.copy(c); m.sprite.material.opacity = 0.25; }
                }
            });

            // Update heat texture
            inst._updateHeatTexture(S, depths);
        };

        inst.setDemo = function () {
            const depths = [];
            for (let d = 0; d < DEPTH_COUNT; d++) {
                let t = 28 + Math.sin(d * 0.8) * 5 + (Math.random() - 0.5) * 3;
                const hotSpot = Math.exp(-((d - 3) * (d - 3)) / 4) * 25;
                t += hotSpot + d * 0.5;
                depths.push(parseFloat(t.toFixed(1)));
            }
            inst.setData(depths, '演示传感器');
        };

        inst.setAutoRotate = function (on) {
            const S = _S();
            if (S) S.autoRotate = !!on;
        };

        inst._updateHeatTexture = function (S, depths) {
            if (!S.heatCtx || !S.heatTexture || !depths) return;
            const ctx = S.heatCtx, w = 128, h = 256;
            ctx.fillStyle = '#434c5b';
            ctx.fillRect(0, 0, w, h);

            for (let d = 0; d < DEPTH_COUNT; d++) {
                if (depths[d] == null || isNaN(depths[d])) continue;
                const cy = h * (1 - d / (DEPTH_COUNT - 1));
                const color = temperatureColorToRgb(depths[d]);
                const [r, g, b] = color;
                const grad = ctx.createRadialGradient(w / 2, cy, 0, w / 2, cy, 40);
                grad.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
                grad.addColorStop(0.4, `rgba(${r},${g},${b},0.5)`);
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, cy - 40, w, 80);
            }
            S.heatTexture.needsUpdate = true;
        };

        inst._updateCamera = function (S) {
            S.camera.position.set(
                S.radius * Math.sin(S.phi) * Math.sin(S.theta),
                S.radius * Math.cos(S.phi),
                S.radius * Math.sin(S.phi) * Math.cos(S.theta)
            );
            S.camera.lookAt(0, PILLAR_HEIGHT / 2, 0);
        };

        inst._animate = function (S) {
            if (!S || !S.scene) return;
            S.rafId = requestAnimationFrame(function () { inst._animate(S); });
            if (S.autoRotate && !S.dragging) S.theta += 0.006;
            const k = 0.12;
            S.dragTheta += (S.theta - S.dragTheta) * k;
            S.dragPhi += (S.phi - S.dragPhi) * k;
            inst._updateCamera(S);
            S.renderer.render(S.scene, S.camera);
        };

        inst._bindEvents = function (S) {
            const el = S.renderer.domElement;
            // 保存句柄以便 destroy 时移除，避免多实例下 window 监听器泄漏
            S._onWinMouseUp = function () { S.dragging = false; };
            S._onWinMouseMove = function (e) {
                if (S.dragging) {
                    const dx = e.clientX - S.lastX, dy = e.clientY - S.lastY;
                    S.lastX = e.clientX; S.lastY = e.clientY;
                    S.theta -= dx * 0.008;
                    S.phi = clamp(S.phi - dy * 0.008, 0.2, Math.PI - 0.2);
                }
            };
            S._onWinResize = function () {
                if (!S.container || !S.renderer) return;
                const w = S.container.clientWidth || 400, h = S.container.clientHeight || 320;
                S.camera.aspect = w / h;
                S.camera.updateProjectionMatrix();
                S.renderer.setSize(w, h);
            };

            el.addEventListener('mousedown', function (e) { S.dragging = true; S.lastX = e.clientX; S.lastY = e.clientY; });
            window.addEventListener('mouseup', S._onWinMouseUp);
            window.addEventListener('mousemove', S._onWinMouseMove);
            el.addEventListener('wheel', function (e) {
                e.preventDefault();
                S.radius = clamp(S.radius + e.deltaY * 0.01, 5, 20);
            }, { passive: false });

            // Touch
            el.addEventListener('touchstart', function (e) {
                if (e.touches.length === 1) { S.dragging = true; S.lastX = e.touches[0].clientX; S.lastY = e.touches[0].clientY; }
            });
            el.addEventListener('touchmove', function (e) {
                if (S.dragging && e.touches.length === 1) {
                    S.lastX = e.touches[0].clientX; S.lastY = e.touches[0].clientY;
                    S.theta -= (e.touches[0].clientX - S.lastX) * 0.008;
                    S.phi = clamp(S.phi - (e.touches[0].clientY - S.lastY) * 0.008, 0.2, Math.PI - 0.2);
                }
            });
            el.addEventListener('touchend', function () { S.dragging = false; });

            window.addEventListener('resize', S._onWinResize);
        };

        inst._destroy = function () {
            const S = _S();
            if (!S) return;
            if (S.rafId) cancelAnimationFrame(S.rafId);
            // 移除 window 级监听器，防止实例泄漏
            if (S._onWinMouseUp) window.removeEventListener('mouseup', S._onWinMouseUp);
            if (S._onWinMouseMove) window.removeEventListener('mousemove', S._onWinMouseMove);
            if (S._onWinResize) window.removeEventListener('resize', S._onWinResize);
            if (S.groundShadowTexture) S.groundShadowTexture.dispose();
            if (S.renderer) {
                S.renderer.dispose();
                if (S.renderer.domElement && S.renderer.domElement.parentNode) {
                    S.renderer.domElement.parentNode.removeChild(S.renderer.domElement);
                }
            }
            // 移除深度标签层
            if (S.labelDiv && S.labelDiv.parentNode) {
                S.labelDiv.parentNode.removeChild(S.labelDiv);
                S.labelDiv = null;
            }
            if (S.scene) {
                S.scene.traverse(function (obj) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) obj.material.forEach(function (m) { m.dispose(); });
                        else obj.material.dispose();
                    }
                });
            }
            inst._state = null;
        };

        inst.destroy = function () { inst._destroy(); };

        inst.resize = function () {
            const S = _S();
            if (!S || !S.container) return;
            const w = S.container.clientWidth || 400, h = S.container.clientHeight || 320;
            S.camera.aspect = w / h;
            S.camera.updateProjectionMatrix();
            S.renderer.setSize(w, h);
        };

        return inst;
    }

    // 工厂函数 —— 用于创建多个独立实例（煤堆3D页面的迷你卡片网格）
    window.createCoalPileDetail = makeInstance;
})();
