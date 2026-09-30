/**
 * IoT 温度监控平台 - 主应用逻辑
 * 管理 UI、模式切换、数据流和图表
 */
(function () {
    'use strict';

    // ===================== 全局状态 =====================
    const STATE = {
        mode: 'emqx',           // 'emqx' | 'socket'
        connected: false,
        uptimeStart: null,
        uptimeTimer: null,
        msgCount: 0,
        msgFilteredCount: 0,    // 被过滤掉的外部消息数
        msgRate: 0,
        msgRateWindow: [],
        lastMsgTime: null,
        topicPrefix: '',        // 命名空间前缀，用于隔离数据

        // 传感器配置（动态数量）
        sensorConfig: {
            count: 3,  // 当前传感器数量
            sensors: [
                { key: 'topic1', name: '传感器 1', qos: 0 },
                { key: 'topic2', name: '传感器 2', qos: 1 },
                { key: 'topic3', name: '传感器 3', qos: 2 }
            ]
        },

        // 温度数据缓存 (使用环形缓冲区替代无限数组)
        sensorData: {
            topic1: { current: null, history: new RingBuffer(2000), depths: [] },
            topic2: { current: null, history: new RingBuffer(2000), depths: [] },
            topic3: { current: null, history: new RingBuffer(2000), depths: [] },
        },

        // 所有接收的数据（用于历史页面）
        allHistory: [],

        // 设置
        settings: {
            alarmHigh: 50,
            alarmLow: 0,
            alarmVolume: 70,
            maxHistorySize: 1000,
            chartInterval: 1000,
            maxChartPoints: 60,
            aiEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
            aiApiKey: '',
        },

        // 图表引用
        chart: null,
        historyChart: null,
        detailChart: null,       // 传感器详情页图表
        detailSensorKey: null,   // 当前查看的传感器
        chartTimer: null,

        // 报警状态
        alarmActive: false,
        alarmDismissed: false,
    };

    // ===================== 客户端实例 =====================
    let datasource = null;
    let alarmEngine = null;

    // ===================== DOM 引用缓存 =====================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);
    const SENSOR_PALETTE = ['#0071e3', '#00a89d', '#f09a37', '#af69d4', '#e46b81', '#547c9c', '#748c4a', '#a78362'];
    const CHART_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

    function chartTooltipOptions() {
        return {
            backgroundColor: 'rgba(255, 255, 255, 0.97)',
            borderColor: 'rgba(29, 29, 31, 0.08)',
            borderWidth: 1,
            titleColor: '#1d1d1f',
            bodyColor: '#6e6e73',
            titleFont: { family: CHART_FONT, size: 12, weight: '600' },
            bodyFont: { family: CHART_FONT, size: 12 },
            titleMarginBottom: 8,
            padding: 14,
            cornerRadius: 12,
            boxWidth: 7,
            boxHeight: 7,
            boxPadding: 5,
            usePointStyle: true,
        };
    }

    // ===================== 持久化 / 3D 状态 =====================
    const HISTORY_STORAGE_KEY = 'iot_monitor_history_v1';
    const HISTORY_SAVE_LIMIT = 3000;
    let historyDirty = false;
    let coal3dReady = false;

    // ===================== 动态传感器初始化 =====================
    function initSensorData() {
        STATE.sensorData = {};
        STATE.sensorConfig.sensors.forEach(sensor => {
            STATE.sensorData[sensor.key] = {
                current: null,
                history: new RingBuffer(2000),
                depths: []
            };
        });
    }

    // ===================== 动态渲染传感器卡片 =====================
    function renderSensorCards() {
        const container = $('#sensorCardsContainer');
        if (!container) return;

        // 清空容器
        container.innerHTML = '';

        // 为每个传感器生成卡片
        STATE.sensorConfig.sensors.forEach((sensor, index) => {
            const num = index + 1;
            const card = document.createElement('div');
            card.className = 'card data-card clickable-card';
            card.style.setProperty('--sensor-accent', SENSOR_PALETTE[index % SENSOR_PALETTE.length]);
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', `查看${sensor.name}详情`);
            card.onclick = () => openTopicDetail(sensor.key);
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openTopicDetail(sensor.key);
                }
            });

            card.innerHTML = `
                <div class="card-header">
                    <h3 class="card-title"><span class="sensor-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14.7V5a3 3 0 0 1 6 0v9.7a5 5 0 1 1-6 0Z"/><path d="M12 8v9"/><circle cx="12" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg></span>${sensor.name}</h3>
                    <span class="badge badge-qos">QoS ${sensor.qos}</span>
                </div>
                <div class="card-body">
                    <div class="sensor-meter">
                        <div class="meter-main">
                            <div class="sensor-reading-label">实时温度</div>
                            <div class="meter-tempwrap">
                                <div class="data-value-large" id="sensor${num}Temp">--.-</div>
                                <div class="data-unit">°C</div>
                            </div>
                            <div class="meter-minis">
                                <div class="mini-item">
                                    <span class="mini-label">电池</span>
                                    <span class="mini-value" id="sensor${num}Bat">--%</span>
                                </div>
                                <div class="mini-item">
                                    <span class="mini-label">压力</span>
                                    <span class="mini-value" id="sensor${num}Press">-- kg</span>
                                </div>
                            </div>
                        </div>
                        <div class="data-bar" title="量程 -10 ~ 70°C">
                            <div class="data-bar-inner-fill" id="sensor${num}Bar" style="width: 0%"></div>
                            <div class="data-bar-needle" id="sensor${num}Needle" style="left: 12.5%"></div>
                        </div>
                        <div class="data-range">
                            <span>-10</span><span>0</span><span>30</span><span>70</span>
                        </div>
                        <div class="meter-footer">
                            <span class="sensor-state" id="sensor${num}State">等待数据</span>
                            <span class="mf-topic">${sensor.key}</span>
                            <span class="mf-action">详情 →</span>
                        </div>
                    </div>
                </div>
            `;

            container.appendChild(card);
            updateSensorDisplay(sensor.key, STATE.sensorData[sensor.key]?.current ?? null);
        });
    }

    // ===================== 动态生成复选框 =====================
    function renderChartCheckboxes() {
        const container = $('#chartCheckboxGroup');
        if (!container) return;
        container.innerHTML = '';
        STATE.sensorConfig.sensors.forEach((sensor, index) => {
            const label = document.createElement('label');
            label.style.display = 'flex'; label.style.alignItems = 'center'; label.style.gap = '5px'; label.style.cursor = 'pointer';
            label.style.setProperty('--sensor-accent', SENSOR_PALETTE[index % SENSOR_PALETTE.length]);
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = true; cb.dataset.sensorIndex = index;
            cb.addEventListener('change', (e) => {
                const idx = parseInt(e.target.dataset.sensorIndex);
                if (STATE.chart && STATE.chart.data.datasets[idx]) {
                    STATE.chart.data.datasets[idx].hidden = !e.target.checked;
                    STATE.chart.update();
                }
            });
            label.appendChild(cb);
            label.appendChild(document.createTextNode(sensor.name));
            container.appendChild(label);
        });
    }

    function renderHistoryFilterCheckboxes() {
        const container = $('#historyFilterGroup');
        if (!container) return;

        // 保留 "测点："标签和深度复选框，在它们前面插入传感器复选框
        const depthLabel = container.querySelector('#fIncludeDepth')?.parentNode;
        const prefix = container.querySelector('.filter-label');

        // 在 prefix 和 depth label 之间插入传感器复选框
        STATE.sensorConfig.sensors.forEach((sensor, index) => {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            label.innerHTML = `<input type="checkbox" data-sensor-key="${sensor.key}" checked> ${sensor.name}`;
            label.querySelector('input').addEventListener('change', () => {
                updateHistoryTable(getCheckedHistorySensors());
            });

            if (depthLabel) {
                container.insertBefore(label, depthLabel);
            } else {
                container.appendChild(label);
            }
        });
    }

    function getCheckedHistorySensors() {
        const checkboxes = document.querySelectorAll('#historyFilterGroup input[type="checkbox"]');
        return Array.from(checkboxes)
            .filter(cb => cb.checked && cb.dataset.sensorKey)
            .map(cb => cb.dataset.sensorKey);
    }

    // ===================== 传感器数量变更 =====================
    function rebuildSensorConfig(newCount) {
        const oldCount = STATE.sensorConfig.count;

        // 更新配置
        STATE.sensorConfig.count = newCount;

        // 扩展或缩减传感器列表
        if (newCount > oldCount) {
            for (let i = oldCount + 1; i <= newCount; i++) {
                STATE.sensorConfig.sensors.push({
                    key: `topic${i}`,
                    name: `传感器 ${i}`,
                    qos: (i - 1) % 3
                });
            }
        } else if (newCount < oldCount) {
            STATE.sensorConfig.sensors = STATE.sensorConfig.sensors.slice(0, newCount);
        }

        // 重建所有模块
        initSensorData();
        renderSensorCards();
        renderChartCheckboxes();
        renderHistoryFilterCheckboxes();
        syncAlarmConfig();

        // 重建图表
        if (STATE.chart) STATE.chart.destroy();
        if (STATE.historyChart) STATE.historyChart.destroy();
        setupCharts();
        if (STATE.chartTimer) { clearInterval(STATE.chartTimer); startChartUpdateTimer(); }

        // 通知 3D 模块
        if (coal3dReady && CoalPile3D.setSensorKeys) {
            CoalPile3D.setSensorKeys(STATE.sensorConfig.sensors.map(s => s.key));
        }
        // 重建煤堆3D卡片网格（如果当前在该页面）
        if ($('#page-coal3d') && $('#page-coal3d').classList.contains('active')) {
            renderCoal3dSensorCards();
        }

        addLog({ level: 'info', message: `传感器数量已更新为 ${newCount}` });
        // 同步连接配置卡片和设置页面的数量显示
        const configInput = $('#configSensorCount');
        if (configInput && parseInt(configInput.value) !== newCount) configInput.value = newCount;
        const settingsInput = $('#sensorCount');
        if (settingsInput && parseInt(settingsInput.value) !== newCount) settingsInput.value = newCount;
        updateTopicPreview();
    }

    function updateTopicPreview() {
        const el = $('#configTopicPreview');
        const input = $('#configSensorCount');
        if (el && input) {
            const n = parseInt(input.value) || 3;
            const topics = Array.from({length: n}, (_, i) => `topic${i + 1}`).join(', ');
            el.textContent = '→ ' + topics;
        }
    }

    // ===================== 全局桥接（供 report.js 等使用） =====================
    window._getSensorConfig = function () { return STATE.sensorConfig; };
    // 返回独立的只读快照，供展示层读取；不暴露可修改的内部状态。
    window.getMonitorOverview = function () {
        const sensorValues = STATE.sensorConfig.sensors.map(sensor => STATE.sensorData[sensor.key]);
        return Object.freeze({
            connected: STATE.connected,
            mode: STATE.mode,
            sensorCount: STATE.sensorConfig.sensors.length,
            activeSensorCount: sensorValues.filter(sensor => sensor && sensor.current != null).length,
            lastMsgTime: STATE.lastMsgTime,
            alarmHigh: STATE.settings.alarmHigh,
            alarmLow: STATE.settings.alarmLow,
            hasTemperatureData: sensorValues.some(sensor => sensor && sensor.current != null),
        });
    };

    // ===================== 初始化 =====================
    function init() {
        // 防御：CDN 库缺失时给出明确提示而不是静默崩溃
        if (typeof Chart === 'undefined') {
            console.error('[IoT] Chart.js 未加载（CDN 不可达？），图表功能不可用');
        }
        initSensorData();
        renderSensorCards();
        bindUIEvents();
        setupCharts();
        renderChartCheckboxes();
        renderHistoryFilterCheckboxes();
        initAlarmEngine();
        loadSettings();
        loadHistory();
        startClock();
        switchMode('emqx');
        navigateTo('dashboard');

        // 历史数据自动保存 + 页面关闭兜底
        setInterval(saveHistory, 3000);
        window.addEventListener('beforeunload', saveHistory);
    }

    // ===================== UI 事件绑定 =====================
    function bindUIEvents() {
        // 侧边栏
        $('#sidebarToggle').addEventListener('click', toggleSidebar);
        $$('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                navigateTo(item.dataset.page);
            });
        });

        // 模式切换
        $('#modeEmqx').addEventListener('click', () => switchMode('emqx'));
        $('#modeSocket').addEventListener('click', () => switchMode('socket'));

        // 连接/断开
        $('#btnConnect').addEventListener('click', doConnect);
        $('#btnDisconnect').addEventListener('click', doDisconnect);

        // 传感器数量即时调整
        const configSensorCount = $('#configSensorCount');
        if (configSensorCount) {
            configSensorCount.addEventListener('input', () => {
                const newCount = parseInt(configSensorCount.value) || 3;
                if (newCount !== STATE.sensorConfig.count && newCount >= 1 && newCount <= 8) {
                    rebuildSensorConfig(newCount);
                    updateTopicPreview();
                }
            });
            updateTopicPreview(); // 初始化预览
        }
        $('#btnClearChart').addEventListener('click', clearChart);

        // 日志
        $('#btnClearLog').addEventListener('click', clearLog);

        // 历史页面
        $('#btnExportCsv').addEventListener('click', exportCsv);
        $('#btnClearHistory').addEventListener('click', clearHistory);

        // 报表生成
        $('#btnReportDaily').addEventListener('click', () => generateReport('daily'));
        $('#btnReportWeekly').addEventListener('click', () => generateReport('weekly'));
        $('#btnAiAnalysis').addEventListener('click', runAiAnalysis);

        // 时间范围快捷预设
        $$('.filter-presets button').forEach(btn => {
            btn.addEventListener('click', () => applyRangePreset(btn.dataset.range));
        });

        // 煤堆 3D
        $('#c3dAutoRotate').addEventListener('change', (e) => {
            if (coal3dReady) CoalPile3D.setAutoRotate(e.target.checked);
        });
        $('#btnC3dReset').addEventListener('click', () => {
            if (coal3dReady) CoalPile3D.resetView();
        });
        const btnC3dBack = $('#btnC3dBack');
        if (btnC3dBack) btnC3dBack.addEventListener('click', backToCoal3dGrid);

        // 设置
        $('#btnSaveSettings').addEventListener('click', saveSettings);

        // 报警
        $('#alarmToast').addEventListener('click', () => {
            STATE.alarmDismissed = true;
            $('#alarmToast').classList.add('hidden');
        });

        // 键盘快捷键
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === '1') switchMode('emqx');
            if (e.ctrlKey && e.key === '2') switchMode('socket');
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                if (STATE.connected) doDisconnect(); else doConnect();
            }
        });
    }

    function bindDatasourceEvents(ds) {
        ds.on('message', (data) => handleIncomingData(data));
        ds.on('status', (state) => {
            if (state === 'connected') onConnected();
            else if (state === 'disconnected') onDisconnected();
        });
        ds.on('log', (entry) => addLog(entry));
    }

    // ===================== 模式切换 =====================
    function switchMode(mode) {
        if (STATE.connected) {
            if (!confirm('切换模式将断开当前连接，确定继续？')) return;
            doDisconnect();
        }

        STATE.mode = mode;

        // 更新模式选项卡
        $('#modeEmqx').classList.toggle('active', mode === 'emqx');
        $('#modeSocket').classList.toggle('active', mode === 'socket');

        // 切换配置面板
        $('#configEmqx').classList.toggle('hidden', mode !== 'emqx');
        $('#configSocket').classList.toggle('hidden', mode !== 'socket');

        // 更新模式文本
        $('#textMode').textContent = mode === 'emqx' ? 'EMQX MQTT' : '网口直连';

        // 更新按钮状态
        updateConnectButtons();
    }

    // ===================== 连接 / 断开（使用 DataSource 统一接口） =====================
    function doConnect() {
        if (STATE.connected) return;

        // 销毁旧连接
        if (datasource) {
            datasource.removeAllListeners();
            datasource = null;
        }

        datasource = DataSourceFactory.create(STATE.mode);
        bindDatasourceEvents(datasource);

        if (STATE.mode === 'emqx') {
            const prefix = ($('#emqxPrefix').value.trim() || generatePrefix()).replace(/[\/#+\s]/g, '_');
            STATE.topicPrefix = prefix;
            $('#emqxPrefix').value = prefix;

            const subtopics = STATE.sensorConfig.sensors.map(s => s.key);
            const topics = subtopics.map(t => `${prefix}/${t}`);

            addLog({ level: 'info', message: `命名空间: "${prefix}" → 订阅 ${topics.join(', ')}` });

            datasource.connect({
                host: $('#emqxHost').value.trim() || 'broker.emqx.io',
                port: parseInt($('#emqxPort').value) || 8083,
                clientId: $('#emqxClientId').value.trim() || `${prefix}_dashboard`,
                username: $('#emqxUsername').value.trim() || undefined,
                password: $('#emqxPassword').value || undefined,
                topics: topics,
            });
        } else {
            datasource.connect({
                host: $('#socketHost').value.trim() || '192.168.1.100',
                port: parseInt($('#socketPort').value) || 9000,
                protocol: $('#socketProtocol').value,
                format: $('#socketFormat').value,
            });
        }
    }

    function doDisconnect() {
        if (datasource) {
            datasource.disconnect();
            datasource.removeAllListeners();
        }
        datasource = null;
        STATE.connected = false;
        onDisconnected();
    }

    // ===================== 连接状态处理 =====================
    function onConnected() {
        STATE.connected = true;
        STATE.msgCount = 0;
        STATE.msgFilteredCount = 0;
        STATE.msgRateWindow = [];
        STATE.alarmDismissed = false;
        STATE.uptimeStart = Date.now();

        updateConnectButtons();
        updateConnectionStatus(true);
        startUptimeTimer();

        addLog({ level: 'info', message: '═══ 连接已建立 ═══' });
    }

    function onDisconnected() {
        STATE.connected = false;
        if (STATE.uptimeTimer) {
            clearInterval(STATE.uptimeTimer);
            STATE.uptimeTimer = null;
        }

        updateConnectButtons();
        updateConnectionStatus(false);

        addLog({ level: 'warn', message: '─── 连接已断开 ───' });
    }

    function updateConnectButtons() {
        const connected = STATE.connected;
        $('#btnConnect').disabled = connected;
        $('#btnDisconnect').disabled = !connected;

        if (connected) {
            $('#btnConnect').style.display = 'none';
            $('#btnDisconnect').style.display = 'flex';
        } else {
            $('#btnConnect').style.display = 'flex';
            $('#btnDisconnect').style.display = 'none';
        }
    }

    function updateConnectionStatus(connected) {
        // 顶部 badge
        const badge = $('#connectionBadge');
        badge.textContent = connected ? '● 在线' : '● 离线';
        badge.className = 'badge ' + (connected ? 'online' : 'offline');

        // LED
        const led = $('#ledConnection');
        led.className = 'led ' + (connected ? 'led-on' : 'led-off');

        // 文本
        $('#textConnection').textContent = connected ? '已连接' : '未连接';

        // 侧边栏
        const sidebarDot = $('#sidebarStatusDot');
        sidebarDot.className = 'status-dot ' + (connected ? 'connected' : '');
        $('#sidebarStatusText').textContent = connected ? '在线' : '未连接';
    }

    // ===================== 数据处理 =====================
    function handleIncomingData(data) {
        STATE.msgCount++;
        STATE.lastMsgTime = Date.now();

        const topic = data.topic || 'socket';
        let pl = data.payload || {};

        // 网口直连模式: 桥接服务器转发的外层 {timestamp, source, payload}
        if (pl && pl.source === 'stm32mp157' && pl.payload && typeof pl.payload === 'object') {
            pl = pl.payload;
        }

        // ---- 网关工作模式: 联网模式 / 断网本地闭环模式 ----
        if (pl.work_mode !== undefined) {
            const wmEl = $('#textMode');
            if (pl.work_mode === 'offline') {
                wmEl.textContent = '断网本地闭环';
                wmEl.style.color = '#d9a441';
            } else {
                wmEl.textContent = '联网模式';
                wmEl.style.color = '#8fbf8f';
            }
        }

        // ---- 命名空间过滤 (EMQX 模式) ----
        // 只处理匹配我们命名空间的消息，过滤掉公共服务器上其他人的数据
        if (STATE.mode === 'emqx' && STATE.topicPrefix) {
            if (!topic.startsWith(STATE.topicPrefix + '/') && topic !== STATE.topicPrefix) {
                STATE.msgFilteredCount++;
                // 每过滤 20 条记录一条日志，避免刷屏
                if (STATE.msgFilteredCount % 20 === 1) {
                    addLog({ level: 'warn', message: `已过滤 ${STATE.msgFilteredCount} 条外部消息 (非 "${STATE.topicPrefix}/" 前缀)` });
                }
                return; // ← 丢弃不属于我们的消息
            }
        }

        // 更新外部消息过滤计数
        $('#textPacketLoss').textContent = STATE.msgFilteredCount + ' 条已拦截';

        // 计算消息速率
        const now = Date.now();
        STATE.msgRateWindow.push(now);
        STATE.msgRateWindow = STATE.msgRateWindow.filter(t => now - t < 5000);
        STATE.msgRate = STATE.msgRateWindow.length;

        // ---- 网口直连: 设备每 2 秒推一帧 {t1,t2,t3,depths,bat1,press1,bat2,press2} ----
        if (STATE.mode === 'socket' && (pl.t1 !== undefined || pl.t2 !== undefined || pl.t3 !== undefined)) {
            // 深度剖面（若设备端提供 depths 数组则整组采集，否则留空）
            const depths = extractDepthArray(pl);
            const rows = [
                { key: 'topic1', temp: numOrNull(pl.t1), bat: pl.bat1, press: pl.press1 },
                { key: 'topic2', temp: numOrNull(pl.t2), bat: pl.bat2, press: pl.press2 },
                { key: 'topic3', temp: numOrNull(pl.t3), bat: null, press: null },
            ];
            rows.forEach(r => {
                if (r.temp !== null) {
                    applySensorValue(r.key, r.temp, now, topic);
                    if (depths) STATE.sensorData[r.key].depths = depths;
                    STATE.allHistory.push({
                        timestamp: new Date(now),
                        topic: topic,
                        sensor: r.key,
                        temperature: r.temp,
                        depths: depths,
                        raw: data.raw,
                    });
                    historyDirty = true;
                }
                updateDeviceMeta(r.key, r.bat, r.press);
            });
            if (STATE.allHistory.length > STATE.settings.maxHistorySize) {
                STATE.allHistory.splice(0, STATE.allHistory.length - STATE.settings.maxHistorySize);
            }
            syncCoal3D();
            syncMiniCoal3DData();
            updateMiniCoal3DTemps();
            updateRates();
            return;
        }

        // ---- EMQX 模式: {"device":N,"t":[8深度温度],"bat":N,"press":N,"ts":...} ----
        let temperature = null;
        if (Array.isArray(pl.t) && pl.t.length > 0) {
            temperature = numOrNull(pl.t[0]);  // 表层温度
        } else if (pl.temperature !== undefined || pl.temp !== undefined
                   || pl.value !== undefined || pl.t !== undefined) {
            temperature = numOrNull(pl.temperature !== undefined ? pl.temperature
                                  : (pl.temp !== undefined ? pl.temp
                                  : (pl.value !== undefined ? pl.value : pl.t)));
        } else if (pl.raw !== undefined) {
            temperature = numOrNull(pl.raw);
        }
        if (temperature !== null) {
            temperature = parseFloat(temperature.toFixed(2));
        }

        // 根据 topic 或 device 字段分配到对应传感器（动态匹配，支持任意数量）
        const sensorKeys = STATE.sensorConfig.sensors.map(s => s.key);
        let sensorKey = null;
        // 1) 按主题名匹配（如 iot_device/topic4 → topic4）
        for (const key of sensorKeys) {
            if (topic.includes(key)) { sensorKey = key; break; }
        }
        // 2) 按 device 字段匹配（device:1 → 第1个传感器）
        if (!sensorKey && typeof pl.device === 'number') {
            const idx = pl.device - 1;
            if (idx >= 0 && idx < sensorKeys.length) sensorKey = sensorKeys[idx];
        }
        // 3) 没有明确来源时轮流分配
        if (!sensorKey && temperature !== null && sensorKeys.length > 0) {
            STATE._lastAssignIdx = ((STATE._lastAssignIdx || 0) + 1) % sensorKeys.length;
            sensorKey = sensorKeys[STATE._lastAssignIdx];
        }

        if (sensorKey && temperature !== null) {
            applySensorValue(sensorKey, temperature, now, topic);
        }
        if (sensorKey) {
            updateDeviceMeta(sensorKey, pl.bat, pl.press);
        }

        // 采集 8 深度温度数组（EMQX: pl.t；网口直连: pl.depths）
        const depths = extractDepthArray(pl);
        if (sensorKey && depths) {
            STATE.sensorData[sensorKey].depths = depths;
        }

        // 添加到全局历史
        STATE.allHistory.push({
            timestamp: new Date(now),
            topic: topic,
            sensor: sensorKey || 'unknown',
            temperature: temperature,
            depths: depths,
            raw: data.raw,
        });
        historyDirty = true;

        // 限制全局历史
        if (STATE.allHistory.length > STATE.settings.maxHistorySize) {
            STATE.allHistory.shift();
        }

        syncCoal3D();
        syncMiniCoal3DData();
        updateMiniCoal3DTemps();
        updateRates();
    }

    function numOrNull(v) {
        if (v === undefined || v === null) return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
    }

    /**
     * 从 payload 中提取 8 深度温度数组
     * EMQX 模式: pl.t（8 深度温度）；网口直连: pl.depths
     */
    function extractDepthArray(pl) {
        if (Array.isArray(pl.t) && pl.t.length > 0) {
            return pl.t.map(numOrNull);
        }
        if (Array.isArray(pl.depths) && pl.depths.length > 0) {
            return pl.depths.map(numOrNull);
        }
        return null;
    }

    function applySensorValue(sensorKey, temperature, now, topic) {
        STATE.sensorData[sensorKey].current = temperature;
        // 环形缓冲区自动管理容量，无需手动限制
        STATE.sensorData[sensorKey].history.push({
            time: new Date(now),
            value: temperature,
            topic: sensorKey,
        });

        updateSensorDisplay(sensorKey, temperature);
        checkAlarm(sensorKey, temperature);
    }

    function updateDeviceMeta(sensorKey, battery, pressure) {
        // 动态生成 ID 映射
        const idMap = {};
        STATE.sensorConfig.sensors.forEach((sensor, index) => {
            const num = index + 1;
            idMap[sensor.key] = { bat: `sensor${num}Bat`, press: `sensor${num}Press` };
        });
        const ids = idMap[sensorKey];
        if (!ids) return;

        // 电池电量
        const batEl = document.getElementById(ids.bat);
        if (batEl) {
            if (battery === undefined || battery === null) {
                batEl.textContent = '--%';
                batEl.classList.remove('meta-low', 'meta-warn');
            } else {
                const b = parseInt(battery);
                if (isNaN(b)) {
                    batEl.textContent = '--%';
                } else {
                    batEl.textContent = `${b}%`;
                    batEl.classList.remove('meta-low', 'meta-warn');
                    if (b <= 20) batEl.classList.add('meta-low');
                    else if (b <= 50) batEl.classList.add('meta-warn');
                }
            }
        }

        // 压力
        const pressEl = document.getElementById(ids.press);
        if (pressEl) {
            if (pressure === undefined || pressure === null) {
                pressEl.textContent = '-- kg';
            } else {
                const p = parseFloat(pressure);
                pressEl.textContent = isNaN(p) ? '-- kg' : `${p.toFixed(1)} kg`;
            }
        }
    }

    function updateRates() {
        $('#textMsgRate').textContent = `${STATE.msgRate} msg/s`;
        $('#textMsgCount').textContent = STATE.msgCount;
    }

    // ===================== 更新传感器显示 =====================
    function updateSensorDisplay(sensorKey, temperature) {
        // 动态生成 ID 映射
        const idMap = {};
        STATE.sensorConfig.sensors.forEach((sensor, index) => {
            const num = index + 1;
            idMap[sensor.key] = { temp: `sensor${num}Temp`, bar: `sensor${num}Bar`, state: `sensor${num}State` };
        });

        const ids = idMap[sensorKey];
        if (!ids) return;

        const stateEl = document.getElementById(ids.state);
        if (stateEl) {
            stateEl.textContent = temperature != null ? '实时读数' : '等待数据';
            stateEl.classList.toggle('has-reading', temperature != null);
        }

        // 更新温度数字（整数大数字 + 小数降级）
        const tempEl = document.getElementById(ids.temp);
        if (tempEl) {
            tempEl.classList.remove('alarm-high', 'alarm-low');
            if (temperature == null) {
                tempEl.textContent = '--.-';
            } else {
                const fixed = temperature.toFixed(1);
                const dot = fixed.indexOf('.');
                const intPart = dot >= 0 ? fixed.slice(0, dot) : fixed;
                const decPart = dot >= 0 ? fixed.slice(dot + 1) : '0';
                tempEl.innerHTML = `${intPart}<span class="temp-decimal">.${decPart}</span>`;
                if (temperature >= STATE.settings.alarmHigh) {
                    tempEl.classList.add('alarm-high');
                } else if (temperature <= STATE.settings.alarmLow) {
                    tempEl.classList.add('alarm-low');
                }
            }
        }

        // 更新温度轨：填充从左生长，游标指示当前值
        const pct = temperature == null ? 0 : Math.max(0, Math.min(100, ((temperature + 10) / 80) * 100));
        const barEl = document.getElementById(ids.bar);
        if (barEl) barEl.style.width = `${pct}%`;
        const num = ids.temp.replace('sensor', '').replace('Temp', '');
        const needleEl = document.getElementById(`sensor${num}Needle`);
        if (needleEl) {
            needleEl.style.left = `${pct}%`;
            needleEl.style.visibility = temperature == null ? 'hidden' : 'visible';
        }
    }

    // ===================== 告警引擎（替代旧 checkAlarm） =====================
    function initAlarmEngine() {
        // 动态生成报警规则
        const buildRules = () => {
            const rules = [];
            STATE.sensorConfig.sensors.forEach((sensor, index) => {
                const num = index + 1;
                // 高温规则
                rules.push({
                    name: `sensor${num}_high`,
                    sensor: sensor.key,
                    on: 'temperature',
                    lookup: { method: 'average', duration: 10 },
                    every: 3,
                    warn: STATE.settings.alarmHigh,
                    crit: STATE.settings.alarmHigh + 5,
                    delay: 3,
                    repeat: 60,
                });
                // 低温规则
                rules.push({
                    name: `sensor${num}_low`,
                    sensor: sensor.key,
                    on: 'temperature',
                    lookup: { method: 'average', duration: 10 },
                    every: 3,
                    warn: STATE.settings.alarmLow - 5,
                    crit: STATE.settings.alarmLow,
                    delay: 3,
                    repeat: 60,
                });
            });
            return rules;
        };

        alarmEngine = new AlarmEngine({
            onAlert: function (evt) {
                showAlarmToast(evt.sensorKey, evt.value, evt.status, evt.isRepeat);
                if (!evt.isRepeat) playAlarmSound();
            },
            onClear: function (evt) {
                addLog({ level: 'info', message: evt.sensorKey + ' 温度恢复正常' });
            },
        });

        alarmEngine.configure({ rules: buildRules(), silencers: [] });
    }

    /** 同步告警引擎配置（阈值变更后调用） */
    function syncAlarmConfig() {
        if (!alarmEngine) return;

        // 动态生成报警规则
        const rules = [];
        STATE.sensorConfig.sensors.forEach((sensor, index) => {
            const num = index + 1;
            // 高温规则
            rules.push({
                name: `sensor${num}_high`,
                sensor: sensor.key,
                on: 'temperature',
                lookup: { method: 'average', duration: 10 },
                every: 3,
                warn: STATE.settings.alarmHigh,
                crit: STATE.settings.alarmHigh + 5,
                delay: 3,
                repeat: 60,
            });
            // 低温规则
            rules.push({
                name: `sensor${num}_low`,
                sensor: sensor.key,
                on: 'temperature',
                lookup: { method: 'average', duration: 10 },
                every: 3,
                warn: STATE.settings.alarmLow - 5,
                crit: STATE.settings.alarmLow,
                delay: 3,
                repeat: 60,
            });
        });

        alarmEngine.configure({
            rules: rules,
            silencers: [],
        });
    }

    // ===================== 报警检测（使用新引擎） =====================
    function checkAlarm(sensorKey, temperature) {
        if (!alarmEngine) return;
        alarmEngine.push(sensorKey, temperature);
    }

    function getSensorName(key) {
        const sensor = STATE.sensorConfig.sensors.find(s => s.key === key);
        return sensor ? sensor.name : key;
    }

    function showAlarmToast(sensorKey, temperature, status, isRepeat) {
        if (STATE.alarmDismissed && isRepeat) return;

        const toast = $('#alarmToast');
        const text = $('#alarmToastText');
        const sensorName = getSensorName(sensorKey);
        const levelLabel = status === 'critical' ? '🔴 严重' : '🟡 预警';
        const repeatLabel = isRepeat ? ' (持续告警)' : '';
        const thresh = status === 'critical'
            ? STATE.settings.alarmHigh + 5
            : STATE.settings.alarmHigh;

        text.textContent = `${levelLabel} ${sensorName}: ${temperature.toFixed(1)}°C (阈值: ${thresh}°C)${repeatLabel}`;

        // 根据等级设置颜色
        toast.style.background = status === 'critical' ? '#c62828' : '#e65100';
        toast.classList.remove('hidden');

        // 非重复告警: 5秒后自动隐藏
        if (!isRepeat) {
            setTimeout(() => {
                toast.classList.add('hidden');
                toast.style.background = '';
            }, 5000);
        } else {
            // 重复告警: 3秒后隐藏
            setTimeout(() => {
                toast.classList.add('hidden');
                toast.style.background = '';
            }, 3000);
        }
    }

    function playAlarmSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const vol = STATE.settings.alarmVolume / 100;

            // 播放 3 声蜂鸣
            [0, 0.2, 0.4].forEach(delay => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = 880;
                osc.type = 'square';
                gain.gain.setValueAtTime(vol * 0.3, ctx.currentTime + delay);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.15);
                osc.start(ctx.currentTime + delay);
                osc.stop(ctx.currentTime + delay + 0.15);
            });
        } catch (e) {
            // 静默处理不支持 AudioContext 的情况
        }
    }

    // ===================== 图表 =====================
    function setupCharts() {
        if (typeof Chart === 'undefined') {
            console.error('[IoT] Chart.js 未加载，跳过图表初始化');
            return;
        }
        // 与传感器卡片一致的清晰、轻量配色。
        const chartColors = SENSOR_PALETTE;

        function generateDatasets(type) {
            return STATE.sensorConfig.sensors.map((sensor, index) => {
                const color = chartColors[index % chartColors.length];
                const rgbColor = hexToRgb(color);
                const bgColor = type === 'realtime'
                    ? `rgba(${rgbColor.r},${rgbColor.g},${rgbColor.b},0.045)`
                    : 'transparent';

                return {
                    label: sensor.name,
                    data: [],
                    borderColor: color,
                    backgroundColor: bgColor,
                    borderWidth: 2.5,
                    tension: type === 'realtime' ? 0.4 : 0.3,
                    fill: type === 'realtime',
                    pointRadius: type === 'realtime' ? 0 : 1,
                    pointHoverRadius: type === 'realtime' ? 5 : undefined,
                    pointHoverBackgroundColor: type === 'realtime' ? color : undefined,
                };
            });
        }

        function hexToRgb(hex) {
            const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? {
                r: parseInt(result[1], 16),
                g: parseInt(result[2], 16),
                b: parseInt(result[3], 16)
            } : { r: 66, g: 133, b: 244 };
        }

        // 实时温度图表
        const ctx1 = $('#temperatureChart').getContext('2d');
        STATE.chart = new Chart(ctx1, {
            type: 'line',
            data: {
                labels: [],
                datasets: generateDatasets('realtime'),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        display: false,
                        position: 'top',
                        labels: {
                            usePointStyle: true,
                            padding: 20,
                            font: { size: 12 },
                        },
                    },
                    tooltip: chartTooltipOptions(),
                },
                scales: {
                    x: {
                        display: true,
                        grid: { display: false },
                        border: { display: false },
                        ticks: { font: { family: CHART_FONT, size: 11 }, color: '#8a8a91', maxTicksLimit: 8, maxRotation: 0, padding: 10 },
                    },
                    y: {
                        min: -20,
                        max: 80,
                        grid: { color: 'rgba(29,29,31,0.055)', drawTicks: false },
                        border: { display: false },
                        ticks: {
                            font: { family: CHART_FONT, size: 11 },
                            color: '#8a8a91',
                            padding: 12,
                            callback: (v) => v + '°C',
                        },
                        title: {
                            display: false,
                            text: '温度 (°C)',
                            font: { size: 12, weight: '600' },
                        },
                    },
                },
            },
        });

        // 添加报警阈值线（使用插件）
        addThresholdPlugin(STATE.chart);

        // 历史图表
        const ctx2 = $('#historyChart').getContext('2d');
        STATE.historyChart = new Chart(ctx2, {
            type: 'line',
            data: {
                labels: [],
                datasets: generateDatasets('history'),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, padding: 20, font: { family: CHART_FONT, size: 12 } },
                    },
                    tooltip: chartTooltipOptions(),
                },
                scales: {
                    x: {
                        grid: { display: false },
                        border: { display: false },
                        ticks: { font: { family: CHART_FONT, size: 11 }, color: '#8a8a91', maxTicksLimit: 8, maxRotation: 0, padding: 10 },
                    },
                    y: {
                        grid: { color: 'rgba(29,29,31,0.055)', drawTicks: false },
                        border: { display: false },
                        ticks: {
                            font: { family: CHART_FONT, size: 11 }, color: '#8a8a91', padding: 12,
                            callback: (v) => v + '°C',
                        },
                    },
                },
            },
        });

        // 启动图表更新定时器
        startChartUpdateTimer();
    }

    function addThresholdPlugin(chart) {
        // 使用 Chart.js 注解或自定义绘制
        const originalDraw = chart.draw;
        chart.draw = function () {
            originalDraw.apply(this, arguments);
            const ctx = chart.ctx;
            const xAxis = chart.scales.x;
            const yAxis = chart.scales.y;

            if (!xAxis || !yAxis) return;

            ctx.save();

            // 高温阈值线
            const highY = yAxis.getPixelForValue(STATE.settings.alarmHigh);
            ctx.beginPath();
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = '#d85d4a';
            ctx.lineWidth = 1.5;
            ctx.moveTo(xAxis.left, highY);
            ctx.lineTo(xAxis.right, highY);
            ctx.stroke();

            // 标签
            ctx.fillStyle = '#d85d4a';
            ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
            ctx.fillText(`报警阈值 ${STATE.settings.alarmHigh}°C`, xAxis.right - 130, highY - 6);

            // 低温阈值线
            const lowY = yAxis.getPixelForValue(STATE.settings.alarmLow);
            ctx.beginPath();
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = '#6fa8bf';
            ctx.lineWidth = 1.5;
            ctx.moveTo(xAxis.left, lowY);
            ctx.lineTo(xAxis.right, lowY);
            ctx.stroke();

            ctx.fillStyle = '#6fa8bf';
            ctx.fillText(`低温阈值 ${STATE.settings.alarmLow}°C`, xAxis.right - 130, lowY - 6);

            ctx.setLineDash([]);
            ctx.restore();
        };
    }

    function updateChartDataset() {
        // 动态读取所有复选框状态
        const checkboxes = document.querySelectorAll('#chartCheckboxGroup input[type="checkbox"]');
        checkboxes.forEach((cb) => {
            const idx = parseInt(cb.dataset.sensorIndex);
            if (!isNaN(idx) && STATE.chart && STATE.chart.data.datasets[idx]) {
                STATE.chart.data.datasets[idx].hidden = !cb.checked;
            }
        });
        STATE.chart.update('none');
    }

    function startChartUpdateTimer() {
        if (STATE.chartTimer) clearInterval(STATE.chartTimer);
        STATE.chartTimer = setInterval(() => {
            const maxPts = STATE.settings.maxChartPoints;
            const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });

            // 更新实时图表
            const chart = STATE.chart;
            chart.data.labels.push(now);
            if (chart.data.labels.length > maxPts) {
                chart.data.labels.shift();
            }

            STATE.sensorConfig.sensors.map(s => s.key).forEach((key, i) => {
                const val = STATE.sensorData[key].current;
                chart.data.datasets[i].data.push(val);
                if (chart.data.datasets[i].data.length > maxPts) {
                    chart.data.datasets[i].data.shift();
                }
            });

            chart.update('none');

            // 更新历史图表
            const hChart = STATE.historyChart;
            STATE.sensorConfig.sensors.map(s => s.key).forEach((key, i) => {
                const history = STATE.sensorData[key].history;
                hChart.data.labels = history.map(h => {
                    const d = new Date(h.time);
                    return d.toLocaleTimeString('zh-CN', { hour12: false });
                });
                hChart.data.datasets[i].data = history.map(h => h.value);
            });
            hChart.update('none');

            // 如果详情页打开，同步更新
            if (STATE.detailSensorKey) {
                updateDetailPage(STATE.detailSensorKey);
            }

            // 更新历史统计
            updateHistoryStats();
            updateHistoryTable();
        }, STATE.settings.chartInterval);
    }

    function clearChart() {
        const chart = STATE.chart;
        chart.data.labels = [];
        chart.data.datasets.forEach(ds => ds.data = []);
        chart.update();
    }

    // ===================== 历史数据 =====================
    function updateHistoryStats() {
        const allVals = [];
        STATE.sensorConfig.sensors.map(s => s.key).forEach(key => {
            STATE.sensorData[key].history.forEach(h => allVals.push(h.value));
        });

        if (allVals.length === 0) {
            $('#hCount').textContent = '0';
            $('#hMax').textContent = '--°C';
            $('#hMin').textContent = '--°C';
            $('#hAvg').textContent = '--°C';
            return;
        }

        $('#hCount').textContent = allVals.length;
        $('#hMax').textContent = Math.max(...allVals).toFixed(1) + '°C';
        $('#hMin').textContent = Math.min(...allVals).toFixed(1) + '°C';
        $('#hAvg').textContent = (allVals.reduce((a, b) => a + b, 0) / allVals.length).toFixed(1) + '°C';
    }

    function updateHistoryTable() {
        const tbody = $('#historyTableBody');
        const allData = STATE.allHistory.slice(-50).reverse(); // 最近 50 条

        if (allData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="table-empty">暂无历史数据</td></tr>';
            return;
        }

        tbody.innerHTML = allData.map((d, i) => `
            <tr>
                <td>${allData.length - i}</td>
                <td>${new Date(d.timestamp).toLocaleString('zh-CN')}</td>
                <td>${d.sensor || d.topic}</td>
                <td>${d.temperature !== null ? d.temperature.toFixed(2) + ' °C' : '--'}</td>
                <td><span class="badge badge-qos">${d.topic}</span></td>
            </tr>
        `).join('');
    }

    /** CSV 字段转义 */
    function csvCell(v) {
        const s = String(v == null ? '' : v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    /** 根据 UI 筛选条件（测点 + 时间范围）过滤历史记录 */
    function getFilteredHistory() {
        const sensors = new Set(getCheckedHistorySensors());

        const startStr = $('#fStartTime').value;
        const endStr = $('#fEndTime').value;
        const start = startStr ? new Date(startStr) : null;
        const end = endStr ? new Date(endStr) : null;

        return STATE.allHistory.filter(d => {
            if (sensors.size && !sensors.has(d.sensor)) return false;
            if (start && d.timestamp < start) return false;
            if (end && d.timestamp > end) return false;
            return true;
        });
    }

    function exportCsv() {
        const includeDepth = $('#fIncludeDepth').checked;
        const filtered = getFilteredHistory();

        if (filtered.length === 0) {
            addLog({ level: 'warn', message: '筛选范围内没有可导出的数据' });
            showToast('筛选范围内无数据');
            return;
        }

        const header = ['序号', '时间戳', '传感器', '温度(C)', '来源'];
        if (includeDepth) header.push('深度温度(8层)');

        const rows = [header];
        filtered.forEach((d, i) => {
            const row = [
                i + 1,
                csvCell(new Date(d.timestamp).toISOString()),
                csvCell(d.sensor || 'unknown'),
                d.temperature !== null ? d.temperature.toFixed(2) : '',
                csvCell(d.topic || ''),
            ];
            if (includeDepth) {
                const dep = Array.isArray(d.depths) && d.depths.length
                    ? d.depths.map(v => (v === null || v === undefined) ? '' : v).join('|')
                    : '';
                row.push(csvCell(dep));
            }
            rows.push(row);
        });

        const csv = rows.map(r => r.join(',')).join('\r\n');
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `temperature_history_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(url);

        addLog({ level: 'info', message: `已导出 ${filtered.length} 条历史数据到 CSV` });
    }

    function clearHistory() {
        if (!confirm('确定清除所有历史数据？此操作不可撤销。')) return;

        STATE.sensorConfig.sensors.map(s => s.key).forEach(key => {
            STATE.sensorData[key].history.clear();
            STATE.sensorData[key].depths = [];
        });
        STATE.allHistory = [];
        historyDirty = true;
        saveHistory(); // 立即持久化空状态

        STATE.historyChart.data.labels = [];
        STATE.historyChart.data.datasets.forEach(ds => ds.data = []);
        STATE.historyChart.update();
        updateHistoryStats();
        updateHistoryTable();

        addLog({ level: 'info', message: '历史数据已清除' });
    }

    // ===================== 报表生成 =====================
    function generateReport(type) {
        if (STATE.allHistory.length === 0) {
            addLog({ level: 'warn', message: '暂无历史数据，无法生成报表' });
            showToast('暂无历史数据');
            return;
        }
        const records = STATE.allHistory.map(d => ({
            timestamp: d.timestamp,
            topic: d.topic,
            sensor: d.sensor,
            temperature: d.temperature,
        }));
        window.generateReport(type, records, {
            alarmHigh: STATE.settings.alarmHigh,
            alarmLow: STATE.settings.alarmLow,
        });
        addLog({ level: 'info', message: `已生成${type === 'daily' ? '日报' : '周报'}` });
    }

    // ===================== AI 分析 =====================
    async function runAiAnalysis() {
        if (STATE.allHistory.length === 0) {
            addLog({ level: 'warn', message: '暂无历史数据，无法进行 AI 分析' });
            showToast('暂无历史数据');
            return;
        }

        if (!STATE.settings.aiApiKey) {
            addLog({ level: 'warn', message: '请先在系统设置中配置 AI API Key' });
            showToast('请先配置 AI API Key');
            navigateTo('settings');
            return;
        }

        const btn = $('#btnAiAnalysis');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ 分析中...';

        addLog({ level: 'info', message: '🤖 正在进行 AI 分析，请稍候...' });

        try {
            const records = STATE.allHistory.map(d => ({
                timestamp: d.timestamp,
                topic: d.topic,
                sensor: d.sensor,
                temperature: d.temperature,
            }));

            // 计算统计信息
            const temps = records.map(r => r.temperature).filter(t => t !== null && !isNaN(t));
            const stats = {
                count: temps.length,
                max: temps.length ? Math.max(...temps) : 0,
                min: temps.length ? Math.min(...temps) : 0,
                avg: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 0,
                alarmCount: temps.filter(t => t >= STATE.settings.alarmHigh || t <= STATE.settings.alarmLow).length,
            };

            const result = await AiAnalysis.analyze(
                STATE.settings,
                records,
                stats
            );

            // 显示 AI 分析结果
            showAiResult(result);
            addLog({ level: 'info', message: '✅ AI 分析完成' });

        } catch (error) {
            addLog({ level: 'error', message: `❌ AI 分析失败: ${error.message}` });
            showToast('AI 分析失败: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    function showAiResult(result) {
        const win = window.open('', '_blank');
        if (!win) {
            addLog({ level: 'warn', message: '浏览器拦截了弹窗，请允许后重试' });
            return;
        }

        const sectionsHtml = result.sections.map(s => `
            <div class="section">
                <h2>${s.title}</h2>
                <div class="content">${formatMarkdown(s.content)}</div>
            </div>
        `).join('');

        win.document.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>AI 智能分析报告</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f0f2f5; color: #202124; line-height: 1.8; padding: 24px; }
  .container { max-width: 900px; margin: 0 auto; }
  .header { background: linear-gradient(135deg, #1a73e8, #0d47a1); color: white; padding: 32px 40px; border-radius: 14px 14px 0 0; }
  .header h1 { font-size: 24px; margin-bottom: 8px; }
  .header p { opacity: 0.9; font-size: 14px; }
  .report { background: white; border-radius: 0 0 14px 14px; padding: 32px 40px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .section { margin-bottom: 28px; }
  .section h2 { font-size: 18px; color: #1a73e8; border-left: 4px solid #1a73e8; padding-left: 12px; margin-bottom: 12px; }
  .content { font-size: 14px; color: #333; }
  .content ul { margin-left: 20px; margin-top: 8px; }
  .content li { margin-bottom: 6px; }
  .content strong { color: #1a1f36; }
  .content code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .footer { text-align: center; padding: 20px; color: #9aa0a6; font-size: 12px; }
  .btn-print { float: right; background: #1a73e8; color: white; border: none; padding: 10px 24px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .btn-print:hover { background: #1557b0; }
  @media print { .btn-print { display: none; } body { background: white; padding: 0; } .report { box-shadow: none; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <button class="btn-print" onclick="window.print()">🖨️ 打印 / 存为 PDF</button>
    <h1>🤖 AI 智能分析报告</h1>
    <p>IoT 温度监控平台 · 生成于 ${new Date().toLocaleString('zh-CN')}</p>
  </div>
  <div class="report">
    ${sectionsHtml}
  </div>
  <div class="footer">本报告由豆包大模型 AI 自动生成，仅供参考</div>
</div>
</body>
</html>`);
        win.document.close();
    }

    function formatMarkdown(text) {
        return text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/^\- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
            .replace(/\n{2,}/g, '<br><br>')
            .replace(/\n/g, '<br>');
    }

    // ===================== 时间范围快捷预设 =====================
    function toLocalInput(d) {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function applyRangePreset(range) {
        $$('.filter-presets button').forEach(b => b.classList.toggle('active', b.dataset.range === range));
        const end = new Date();
        let start = null;
        if (range === '1h') start = new Date(end.getTime() - 3600e3);
        else if (range === '24h') start = new Date(end.getTime() - 86400e3);
        else if (range === 'today') start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        else if (range === 'week') {
            const d = end.getDay();
            const diff = d === 0 ? 6 : d - 1;
            start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - diff);
        }
        if (start) {
            $('#fStartTime').value = toLocalInput(start);
            $('#fEndTime').value = toLocalInput(end);
        } else {
            $('#fStartTime').value = '';
            $('#fEndTime').value = '';
        }
    }

    // ===================== 历史数据持久化 =====================
    function loadHistory() {
        try {
            const saved = localStorage.getItem(HISTORY_STORAGE_KEY);
            if (!saved) return;
            const parsed = JSON.parse(saved);
            if (!parsed || !Array.isArray(parsed.records)) return;

            const records = parsed.records.slice(-HISTORY_SAVE_LIMIT);
            STATE.allHistory = records.map(r => ({
                timestamp: new Date(r.ts),
                topic: r.topic,
                sensor: r.sensor,
                temperature: r.temperature,
                depths: Array.isArray(r.depths) ? r.depths : null,
                raw: null,
            }));

            // 重建各测点 history / current / depths
            STATE.sensorConfig.sensors.map(s => s.key).forEach(key => {
                const arr = STATE.allHistory.filter(d => d.sensor === key && d.temperature !== null);
                // 清空环形缓冲区后重新填充
                STATE.sensorData[key].history.clear();
                STATE.sensorData[key].history.pushAll(
                    arr.map(d => ({ time: d.timestamp, value: d.temperature, topic: key }))
                );
                const last = arr[arr.length - 1];
                STATE.sensorData[key].current = last ? last.temperature : null;
                updateSensorDisplay(key, STATE.sensorData[key].current);
                for (let i = arr.length - 1; i >= 0; i--) {
                    if (Array.isArray(arr[i].depths)) {
                        STATE.sensorData[key].depths = arr[i].depths;
                        break;
                    }
                }
            });

            if (STATE.allHistory.length > 0) {
                addLog({ level: 'info', message: `已从本地恢复 ${STATE.allHistory.length} 条历史数据` });
            }
        } catch (e) { /* ignore */ }
    }

    function saveHistory() {
        if (!historyDirty) return;
        historyDirty = false;
        try {
            const records = STATE.allHistory.slice(-HISTORY_SAVE_LIMIT).map(d => ({
                ts: d.timestamp ? d.timestamp.getTime() : Date.now(),
                topic: d.topic,
                sensor: d.sensor,
                temperature: d.temperature,
                depths: Array.isArray(d.depths) ? d.depths : null,
            }));
            localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, records }));
        } catch (e) { /* localStorage 满或不可用时静默失败 */ }
    }

    // ===================== 煤堆 3D 同步 =====================

    function setStageDemoBadge(stage, isDemo) {
        if (!stage) return;
        const existing = stage.querySelector('.stage-demo-badge');
        if (!isDemo) {
            if (existing) existing.remove();
            return;
        }
        if (existing) return;
        const badge = document.createElement('span');
        badge.className = 'stage-demo-badge';
        badge.textContent = '演示视图 · 等待设备数据';
        stage.appendChild(badge);
    }

    function buildDepthMap() {
        const map = {};
        STATE.sensorConfig.sensors.map(s => s.key).forEach(key => {
            map[key] = STATE.sensorData[key].depths;
        });
        return map;
    }

    function initCoal3D() {
        if (coal3dReady) return;
        const stage = $('#coal3dStage');
        if (!stage) return;
        const ok = CoalPile3D.init(stage, {
            legendEl: $('#c3dLegendBar'),
            tooltipEl: $('#coal3dTooltip'),
        });
        if (ok) {
            coal3dReady = true;
            const hint = stage.querySelector('.coal3d-hint');
            if (hint) hint.style.display = 'none';

            // 6C: 设置报警阈值
            CoalPile3D.setAlarmThreshold(STATE.settings.alarmHigh, STATE.settings.alarmLow);

            syncCoal3D();
            // 若无真实深度数据，自动填充演示数据，保证画面立即有内容
            const map = buildDepthMap();
            const hasData = STATE.sensorConfig.sensors.map(s => s.key).some(k => Array.isArray(map[k]) && map[k].length > 0);
            if (!hasData) {
                CoalPile3D.setDemo();
                setStageDemoBadge(stage, true);
            }
        }
    }

    function syncCoal3D() {
        if (!coal3dReady) return;
        const map = buildDepthMap();
        const hasData = STATE.sensorConfig.sensors.map(s => s.key).some(k => Array.isArray(map[k]) && map[k].length > 0);
        if (hasData) {
            CoalPile3D.setData(map);
            const stage = $('#coal3dStage');
            const selectedKey = stage ? stage.dataset.sensor : null;
            const selectedHasData = selectedKey
                ? Array.isArray(map[selectedKey]) && map[selectedKey].length > 0
                : hasData;
            setStageDemoBadge(stage, !selectedHasData);
        }
    }

    // ===================== 煤堆 3D 卡片网格 =====================
    /** 迷你 3D 实例列表 */
    let _miniCoalInstances = [];

    /** 渲染煤堆3D页面的传感器卡片网格 */
    function renderCoal3dSensorCards() {
        const grid = $('#coal3dCardGrid');
        if (!grid) return;

        // 先销毁旧的迷你实例
        destroyMiniCoal3DStages();
        grid.innerHTML = '';

        STATE.sensorConfig.sensors.forEach(function (sensor, index) {
            const card = document.createElement('div');
            card.className = 'coal3d-sensor-card';
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', '查看' + sensor.name + '煤堆三维详情');
            card.setAttribute('title', '查看' + sensor.name + '煤堆三维详情');
            card.onclick = function () { openCoal3dDetail(sensor.key); };
            card.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openCoal3dDetail(sensor.key);
                }
            });

            card.innerHTML =
                '<div class="mini-coal3d-stage" data-sensor="' + sensor.key + '">' +
                    '<div class="mini-coal3d-hint">加载中...</div>' +
                '</div>' +
                '<div class="mini-coal3d-info">' +
                    '<span class="mini-coal3d-name">' + sensor.name + '</span>' +
                    '<span class="mini-coal3d-badge">QoS ' + sensor.qos + '</span>' +
                    '<span class="mini-coal3d-temp" id="miniTemp_' + sensor.key + '">--.-°C</span>' +
                '</div>';

            grid.appendChild(card);
        });

        // 初始化迷你 3D
        initMiniCoal3DStages();
    }

    /** 初始化所有迷你煤堆 3D */
    function initMiniCoal3DStages() {
        destroyMiniCoal3DStages();

        var stages = document.querySelectorAll('#coal3dCardGrid .mini-coal3d-stage');
        stages.forEach(function (stage) {
            var sensorKey = stage.dataset.sensor;
            if (!sensorKey) return;

            var hint = stage.querySelector('.mini-coal3d-hint');
            var inst = window.createCoalPileDetail();

            var ok = inst.init(stage, { autoRotate: false });

            if (ok) {
                _miniCoalInstances.push(inst);
                if (hint) hint.style.display = 'none';

                // 设置数据
                var depths = STATE.sensorData[sensorKey] ? STATE.sensorData[sensorKey].depths : [];
                var hasData = Array.isArray(depths) && depths.length > 0;
                if (hasData) {
                    var sensor = STATE.sensorConfig.sensors.find(function (s) { return s.key === sensorKey; });
                    inst.setData(depths, sensor ? sensor.name : sensorKey);
                    setStageDemoBadge(stage, false);
                } else {
                    inst.setDemo();
                    setStageDemoBadge(stage, true);
                }
            } else if (hint) {
                hint.textContent = '3D 加载失败';
            }
        });
    }

    /** 更新迷你卡片温度显示 */
    function updateMiniCoal3DTemps() {
        STATE.sensorConfig.sensors.forEach(function (sensor) {
            var el = document.getElementById('miniTemp_' + sensor.key);
            if (!el) return;
            var val = STATE.sensorData[sensor.key] ? STATE.sensorData[sensor.key].current : null;
            if (val !== null && !isNaN(val)) {
                el.textContent = val.toFixed(1) + '°C';
                el.classList.remove('temp-high', 'temp-low');
                if (val >= STATE.settings.alarmHigh) el.classList.add('temp-high');
                else if (val <= STATE.settings.alarmLow) el.classList.add('temp-low');
            } else {
                el.textContent = '--.-°C';
                el.classList.remove('temp-high', 'temp-low');
            }
        });
    }

    /** 更新迷你3D的深度数据 */
    function syncMiniCoal3DData() {
        _miniCoalInstances.forEach(function (inst) {
            if (!inst._state || !inst._state.container) return;
            var sensorKey = inst._state.container.dataset.sensor;
            if (!sensorKey) return;
            var depths = STATE.sensorData[sensorKey] ? STATE.sensorData[sensorKey].depths : [];
            if (Array.isArray(depths) && depths.length > 0) {
                inst.setData(depths);
                setStageDemoBadge(inst._state.container, false);
            }
        });
    }

    /** 销毁所有迷你 3D 实例 */
    function destroyMiniCoal3DStages() {
        _miniCoalInstances.forEach(function (inst) { inst.destroy(); });
        _miniCoalInstances = [];
    }

    /** 点击卡片 → 进入单传感器全尺寸视图 */
    window.openCoal3dDetail = function (sensorKey) {
        var grid = $('#coal3dCardGrid');
        var detail = $('#coal3dDetailCard');
        var sensor = STATE.sensorConfig.sensors.find(function (s) { return s.key === sensorKey; });
        var sensorName = sensor ? sensor.name : sensorKey;

        // 隐藏卡片网格，显示详情
        if (grid) grid.style.display = 'none';
        if (detail) detail.classList.remove('hidden');

        // 更新标题
        var titleEl = $('#coal3dDetailTitle');
        if (titleEl) {
            titleEl.innerHTML = titleEl.querySelector('.card-title-icon')
                ? titleEl.querySelector('.card-title-icon').outerHTML + ' ' + sensorName
                : sensorName;
        }

        // 初始化主煤堆 3D（如果尚未）
        initCoal3D();
        if (!coal3dReady) return;

        // 切换为单传感器视图
        CoalPile3D.setSensorKeys([sensorKey]);
        CoalPile3D.resize();
        CoalPile3D.setPaused(false);

        // 设置数据
        var depths = STATE.sensorData[sensorKey] ? STATE.sensorData[sensorKey].depths : [];
        var stage = $('#coal3dStage');
        if (stage) stage.dataset.sensor = sensorKey;
        if (Array.isArray(depths) && depths.length > 0) {
            CoalPile3D.setData(buildSingleDepthMap(sensorKey, depths));
            setStageDemoBadge(stage, false);
        } else {
            CoalPile3D.setDemo();
            setStageDemoBadge(stage, true);
        }

        // 绑定返回按钮
        var backBtn = $('#btnC3dBack');
        if (backBtn) backBtn.onclick = backToCoal3dGrid;
    };

    function buildSingleDepthMap(sensorKey, depths) {
        var map = {};
        map[sensorKey] = depths;
        return map;
    }

    /** 返回卡片网格 */
    window.backToCoal3dGrid = function () {
        var grid = $('#coal3dCardGrid');
        var detail = $('#coal3dDetailCard');
        var stage = $('#coal3dStage');
        if (stage) delete stage.dataset.sensor;

        if (grid) grid.style.display = '';
        if (detail) detail.classList.add('hidden');

        // 恢复多传感器视图
        if (coal3dReady) {
            CoalPile3D.setSensorKeys(STATE.sensorConfig.sensors.map(function (s) { return s.key; }));
            CoalPile3D.setPaused(true);
        }

        // 恢复标题
        var titleEl = $('#coal3dDetailTitle');
        if (titleEl) {
            var icon = titleEl.querySelector('.card-title-icon');
            if (icon) {
                titleEl.innerHTML = icon.outerHTML + ' 煤堆详情';
            } else {
                titleEl.textContent = '煤堆详情';
            }
        }
    };

    // ===================== 日志 =====================
    function addLog(entry) {
        const container = $('#logContainer');
        // 清除空状态提示
        const empty = container.querySelector('.log-empty');
        if (empty) empty.remove();

        const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
        const levelClass = entry.level || 'info';
        const msg = entry.message || '';

        const div = document.createElement('div');
        div.className = 'log-entry';
        div.innerHTML = `<span class="time">[${time}]</span> <span class="${levelClass}">${escapeHtml(msg)}</span>`;
        container.appendChild(div);

        // 限制日志条数
        while (container.children.length > 200) {
            container.removeChild(container.firstChild);
        }

        // 滚动到底部
        container.scrollTop = container.scrollHeight;
    }

    function clearLog() {
        const container = $('#logContainer');
        container.innerHTML = '<div class="log-empty">日志已清空</div>';
    }

    // ===================== 设置 =====================
    function loadSettings() {
        try {
            const saved = localStorage.getItem('iot_monitor_settings');
            if (saved) {
                const parsed = JSON.parse(saved);
                Object.assign(STATE.settings, parsed);
            }
        } catch (e) { /* ignore */ }

        // 将设置应用到 UI
        $('#alarmHigh').value = STATE.settings.alarmHigh;
        $('#alarmLow').value = STATE.settings.alarmLow;
        $('#alarmVolume').value = STATE.settings.alarmVolume;
        $('#maxHistorySize').value = STATE.settings.maxHistorySize;
        $('#chartInterval').value = STATE.settings.chartInterval;
        $('#maxChartPoints').value = STATE.settings.maxChartPoints;
        $('#aiEndpoint').value = STATE.settings.aiEndpoint;
        $('#aiApiKey').value = STATE.settings.aiApiKey;
    }

    function saveSettings() {
        // 读取传感器数量配置
        const newSensorCount = parseInt($('#sensorCount').value) || 3;
        const countChanged = newSensorCount !== STATE.sensorConfig.count;

        STATE.settings.alarmHigh = parseFloat($('#alarmHigh').value) || 50;
        STATE.settings.alarmLow = parseFloat($('#alarmLow').value) || 0;
        STATE.settings.alarmVolume = parseInt($('#alarmVolume').value) || 70;
        STATE.settings.maxHistorySize = parseInt($('#maxHistorySize').value) || 1000;
        STATE.settings.chartInterval = parseInt($('#chartInterval').value) || 1000;
        STATE.settings.maxChartPoints = parseInt($('#maxChartPoints').value) || 60;
        STATE.settings.aiEndpoint = $('#aiEndpoint').value.trim();
        STATE.settings.aiApiKey = $('#aiApiKey').value.trim();

        try {
            localStorage.setItem('iot_monitor_settings', JSON.stringify(STATE.settings));
            // 同步告警引擎阈值
            syncAlarmConfig();

            // 同步 3D 场景的报警阈值
            if (coal3dReady && CoalPile3D.setAlarmThreshold) {
                CoalPile3D.setAlarmThreshold(STATE.settings.alarmHigh, STATE.settings.alarmLow);
            }

            // 传感器数量变更：重建
            if (countChanged) rebuildSensorConfig(newSensorCount);

            addLog({ level: 'info', message: '设置已保存' });
            showToast('设置已保存');
        } catch (e) {
            addLog({ level: 'error', message: '保存设置失败: ' + e.message });
        }

        // 重启图表定时器以应用新间隔
        if (STATE.chartTimer) {
            clearInterval(STATE.chartTimer);
            startChartUpdateTimer();
        }
    }

    // ===================== 页面导航 =====================
    function navigateTo(page) {
        // 离开煤堆 3D 页时暂停渲染循环 + 销毁迷你实例
        if (page !== 'coal3d' && coal3dReady) {
            CoalPile3D.setPaused(true);
        }
        if (page !== 'coal3d') {
            destroyMiniCoal3DStages();
        }

        // 更新页面
        $$('.page').forEach(p => p.classList.remove('active'));
        const targetPage = $(`#page-${page}`);
        if (targetPage) targetPage.classList.add('active');

        // 更新导航
        $$('.nav-item').forEach(n => n.classList.remove('active'));
        const targetNav = document.querySelector(`[data-page="${page}"]`);
        if (targetNav) targetNav.classList.add('active');

        // 更新标题
        const titles = {
            dashboard: '仪表盘',
            coal3d: '煤堆3D',
            history: '历史数据',
            settings: '系统设置',
            about: '关于系统',
        };
        $('#pageTitle').textContent = titles[page] || page;

        // 进入煤堆 3D 页：渲染卡片网格 + 懒加载主场景（隐藏）
        if (page === 'coal3d') {
            renderCoal3dSensorCards();
            initCoal3D();
            if (coal3dReady) {
                CoalPile3D.resize();
                CoalPile3D.setPaused(true);  // 初始隐藏详情视图，不渲染
                syncCoal3D();
            }
            // 确保返回列表状态
            var grid = $('#coal3dCardGrid');
            var detail = $('#coal3dDetailCard');
            if (grid) grid.style.display = '';
            if (detail) detail.classList.add('hidden');
        }
    }
    // Shared navigation entry for the separate phone dock presentation.
    window.navigateToPage = navigateTo;

    // ===================== 侧边栏 =====================
    function toggleSidebar() {
        $('#sidebar').classList.toggle('collapsed');
    }

    // ===================== 时钟 =====================
    function startClock() {
        const updateClock = () => {
            const now = new Date();
            $('#topbarClock').textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
        };
        updateClock();
        setInterval(updateClock, 1000);
    }

    // ===================== 运行时长 =====================
    function startUptimeTimer() {
        if (STATE.uptimeTimer) clearInterval(STATE.uptimeTimer);
        STATE.uptimeTimer = setInterval(() => {
            if (!STATE.uptimeStart) return;
            const elapsed = Math.floor((Date.now() - STATE.uptimeStart) / 1000);
            const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
            const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            $('#textUptime').textContent = `${h}:${m}:${s}`;
        }, 1000);
    }

    // ===================== 简易 Toast =====================
    function showToast(message) {
        // 复用报警 toast 的样式做一个简单通知
        const toast = $('#alarmToast');
        if (!toast.classList.contains('hidden')) return;

        toast.style.background = '#557a5c';
        $('#alarmToastText').textContent = '✓ ' + message;
        toast.classList.remove('hidden');

        setTimeout(() => {
            toast.classList.add('hidden');
            toast.style.background = '';
        }, 2500);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * 生成唯一命名空间前缀
     * 格式: iot_<6位随机字符>
     */
    function generatePrefix() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let suffix = '';
        for (let i = 0; i < 6; i++) {
            suffix += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return 'iot_' + suffix;
    }

    // ===================== 传感器详情页 =====================
    /**
     * 点击传感器卡片 → 打开该传感器的详情页
     */
    window.openTopicDetail = function (sensorKey) {
        STATE.detailSensorKey = sensorKey;

        const sensor = STATE.sensorConfig.sensors.find(s => s.key === sensorKey);
        const sensorName = sensor ? sensor.name : sensorKey;
        const qosLabel = sensor ? `QoS ${sensor.qos}` : 'QoS 0';
        const prefix = STATE.topicPrefix || 'iot_device';

        // 填充头部信息
        $('#detailTitle').textContent = sensorName;
        $('#detailSubtitle').textContent = `${prefix}/${sensorKey}`;
        $('#detailBadge').textContent = qosLabel;

        // 切换到详情页
        $$('.page').forEach(p => p.classList.remove('active'));
        $('#page-topic-detail').classList.add('active');
        $('#pageTitle').textContent = sensorName;

        // 更新侧边栏高亮 (取消所有)
        $$('.nav-item').forEach(n => n.classList.remove('active'));

        // 初始化/更新详情图表
        setupDetailChart(sensorKey);
        updateDetailPage(sensorKey);

        // 绑定清除按钮
        $('#btnClearDetailChart').onclick = () => {
            if (STATE.detailChart) {
                STATE.detailChart.data.labels = [];
                STATE.detailChart.data.datasets[0].data = [];
                STATE.detailChart.update();
            }
        };
        $('#btnClearDetailLog').onclick = () => {
            $('#detailTableBody').innerHTML = '<tr><td colspan="4" class="table-empty">日志已清空</td></tr>';
        };
    };

    /**
     * 返回仪表盘
     */
    window.closeTopicDetail = function () {
        STATE.detailSensorKey = null;
        $$('.page').forEach(p => p.classList.remove('active'));
        $('#page-dashboard').classList.add('active');
        $('#pageTitle').textContent = '仪表盘';
        $$('.nav-item').forEach(n => {
            n.classList.remove('active');
            if (n.dataset.page === 'dashboard') n.classList.add('active');
        });
    };

    function setupDetailChart(sensorKey) {
        // 如果已经存在，先销毁
        if (STATE.detailChart) {
            STATE.detailChart.destroy();
            STATE.detailChart = null;
        }

        const canvas = $('#topicDetailChart');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        // 与主图表一致的动态调色板
        const palette = SENSOR_PALETTE;
        const sensorIdx = STATE.sensorConfig.sensors.findIndex(s => s.key === sensorKey);
        const border = palette[(sensorIdx >= 0 ? sensorIdx : 0) % palette.length];
        const rgb = [parseInt(border.slice(1, 3), 16), parseInt(border.slice(3, 5), 16), parseInt(border.slice(5, 7), 16)];
        const c = { border, bg: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.045)` };

        STATE.detailChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '温度',
                    data: [],
                    borderColor: c.border,
                    backgroundColor: c.bg,
                    borderWidth: 2.5,
                    tension: 0.4,
                    fill: true,
                    pointRadius: 1,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: c.border,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, position: 'top', labels: { usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 20, font: { family: CHART_FONT, size: 12 } } },
                    tooltip: {
                        ...chartTooltipOptions(),
                        callbacks: {
                            label: (ctx) => `${ctx.parsed.y.toFixed(2)} °C`,
                        },
                    },
                },
                scales: {
                    x: { grid: { display: false }, border: { display: false }, ticks: { font: { family: CHART_FONT, size: 11 }, color: '#8a8a91', maxTicksLimit: 8, maxRotation: 0, padding: 10 } },
                    y: {
                        min: -20,
                        max: 80,
                        grid: { color: 'rgba(29,29,31,0.055)', drawTicks: false },
                        border: { display: false },
                        ticks: { font: { family: CHART_FONT, size: 11 }, color: '#8a8a91', padding: 12, callback: (v) => v + '°C' },
                    },
                },
            },
        });

        // 添加阈值线
        addDetailThresholdPlugin(STATE.detailChart);
    }

    function addDetailThresholdPlugin(chart) {
        const origDraw = chart.draw;
        chart.draw = function () {
            origDraw.apply(this, arguments);
            const ctx = chart.ctx;
            const xa = chart.scales.x;
            const ya = chart.scales.y;
            if (!xa || !ya) return;

            ctx.save();
            // 高温线
            const hy = ya.getPixelForValue(STATE.settings.alarmHigh);
            ctx.beginPath();
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = '#d85d4a';
            ctx.lineWidth = 1.8;
            ctx.moveTo(xa.left, hy);
            ctx.lineTo(xa.right, hy);
            ctx.stroke();
            ctx.fillStyle = '#d85d4a';
            ctx.font = '11px sans-serif';
            ctx.fillText(`高温 ${STATE.settings.alarmHigh}°C`, xa.right - 110, hy - 6);
            // 低温线
            const ly = ya.getPixelForValue(STATE.settings.alarmLow);
            ctx.beginPath();
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = '#6fa8bf';
            ctx.lineWidth = 1.8;
            ctx.moveTo(xa.left, ly);
            ctx.lineTo(xa.right, ly);
            ctx.stroke();
            ctx.fillStyle = '#6fa8bf';
            ctx.fillText(`低温 ${STATE.settings.alarmLow}°C`, xa.right - 110, ly - 6);
            ctx.setLineDash([]);
            ctx.restore();
        };
    }

    function updateDetailPage(sensorKey) {
        const data = STATE.sensorData[sensorKey];
        if (!data) return;

        const current = data.current;
        const history = data.history;

        // 大温度数字
        const tempEl = $('#detailTempLarge');
        if (tempEl) {
            tempEl.textContent = current !== null ? current.toFixed(1) : '--.-';
            tempEl.classList.remove('alarm-high', 'alarm-low');
            if (current !== null && current >= STATE.settings.alarmHigh) tempEl.classList.add('alarm-high');
            if (current !== null && current <= STATE.settings.alarmLow) tempEl.classList.add('alarm-low');
        }

        // 统计
        const vals = history.map(h => h.value);
        $('#detailCurrent').textContent = current !== null ? current.toFixed(1) + ' °C' : '-- °C';
        $('#detailMax').textContent = vals.length ? Math.max(...vals).toFixed(1) + ' °C' : '-- °C';
        $('#detailMin').textContent = vals.length ? Math.min(...vals).toFixed(1) + ' °C' : '-- °C';
        $('#detailAvg').textContent = vals.length ? (vals.reduce((a,b) => a+b, 0) / vals.length).toFixed(1) + ' °C' : '-- °C';
        $('#detailCount').textContent = vals.length;

        // 报警状态
        if (current !== null && current >= STATE.settings.alarmHigh) {
            $('#detailAlarmStatus').textContent = '⚠ 高温报警';
            $('#detailAlarmStatus').style.color = 'var(--color-danger)';
        } else if (current !== null && current <= STATE.settings.alarmLow) {
            $('#detailAlarmStatus').textContent = '⚠ 低温报警';
            $('#detailAlarmStatus').style.color = 'var(--color-info)';
        } else {
            $('#detailAlarmStatus').textContent = '正常';
            $('#detailAlarmStatus').style.color = 'var(--color-success)';
        }

        // 表格
        const tbody = $('#detailTableBody');
        const recent = history.slice(-30).reverse();
        if (recent.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="table-empty">暂无数据</td></tr>';
        } else {
            tbody.innerHTML = recent.map((h, i) => {
                let status = '正常';
                let statusClass = '';
                if (h.value >= STATE.settings.alarmHigh) { status = '⚠ 高温'; statusClass = 'style="color:#d85d4a;font-weight:600;"'; }
                else if (h.value <= STATE.settings.alarmLow) { status = '⚠ 低温'; statusClass = 'style="color:#6fa8bf;font-weight:600;"'; }
                return `<tr>
                    <td>${recent.length - i}</td>
                    <td>${new Date(h.time).toLocaleTimeString('zh-CN', { hour12: false })}</td>
                    <td><strong>${h.value.toFixed(2)}</strong></td>
                    <td ${statusClass}>${status}</td>
                </tr>`;
            }).join('');
        }

        // 更新详情图表
        if (STATE.detailChart) {
            const chart = STATE.detailChart;
            chart.data.labels = history.map(h => {
                const d = new Date(h.time);
                return d.toLocaleTimeString('zh-CN', { hour12: false });
            });
            chart.data.datasets[0].data = history.map(h => h.value);
            chart.update('none');
        }

        // 更新深度温度网格
        updateDetailDepthGrid(sensorKey);
    }

    function updateDetailDepthGrid(sensorKey) {
        var grid = $('#detailDepthGrid');
        if (!grid) return;

        var depths = STATE.sensorData[sensorKey] ? STATE.sensorData[sensorKey].depths : [];
        var thresholdHigh = STATE.settings.alarmHigh;
        var thresholdLow = STATE.settings.alarmLow;

        var items = grid.querySelectorAll('.depth-item');
        items.forEach(function (item) {
            var depth = parseInt(item.dataset.depth);
            var tempEl = item.querySelector('.depth-temp');
            var barEl = item.querySelector('.depth-bar-fill');

            var val = (Array.isArray(depths) && depths[depth] != null && !isNaN(depths[depth]))
                ? depths[depth] : null;

            if (val != null) {
                tempEl.textContent = val.toFixed(1) + '°C';
                // 温度条：映射 -10~70 到 0~100%
                var pct = Math.max(0, Math.min(100, ((val + 10) / 80) * 100));
                barEl.style.width = pct + '%';

                item.classList.remove('alarm-high', 'alarm-low');
                if (val >= thresholdHigh) item.classList.add('alarm-high');
                else if (val <= thresholdLow) item.classList.add('alarm-low');
            } else {
                tempEl.textContent = '--.-°C';
                barEl.style.width = '0%';
                item.classList.remove('alarm-high', 'alarm-low');
            }
        });
    }

    // ===================== 启动 =====================
    document.addEventListener('DOMContentLoaded', () => {
        // 默认使用 iot_device 前缀（与设备端 MQTT_TOPIC_PREFIX 宏一致）
        // 如果用户未手动修改，保持与设备端同步
        if (!$('#emqxPrefix').value) {
            $('#emqxPrefix').value = 'iot_device';
        }
        init();
    });

})();
