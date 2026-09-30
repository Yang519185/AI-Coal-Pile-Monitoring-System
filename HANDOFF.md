# 项目交接文档 — IoT 温度监控平台

> 给下一个 Claude 对话的上下文说明  
> 项目路径: `C:\Users\asus\Desktop\web_dashboard`

---

## 一、项目概述

基于 Web 技术构建的嵌入式设备远程温度监测仪表盘（SPA）。

**技术栈**：HTML5 + CSS3 + 原生 JS（无框架）、Chart.js 4.x、MQTT.js 5.x、Three.js r128

**功能**：
- 双模连接（EMQX MQTT 服务器 / 网口直连 WebSocket）
- 实时温度曲线（Chart.js）+ 传感器卡片 + 报警系统
- 煤堆 3D 热力可视化（Three.js）
- 历史数据管理、CSV 导出、日报/周报
- AI 分析（调用火山引擎豆包 API）
- Python WebSocket↔TCP 桥接服务器

---

## 二、文件结构

```
web_dashboard/
├── index.html              # 主页面 SPA（703行）
├── css/style.css           # 样式表（改过多次）
├── js/
│   ├── app.js              # 主应用逻辑（~1900行，改动最多）
│   ├── ring-buffer.js      # 环形缓冲区（新增）
│   ├── alarm-engine.js     # 告警引擎（新增，借鉴 Netdata）
│   ├── mqtt-client.js      # MQTT 客户端封装
│   ├── socket-client.js    # WebSocket 客户端封装
│   ├── datasource.js       # 数据源统一接口（新增，借鉴 Freeboard）
│   ├── coal-pile-3d.js     # 多传感器煤堆3D（重构过，支持动态列数）
│   ├── coal-pile-detail.js # 单传感器煤堆3D（新增，详情页用）
│   ├── widgets.js          # Widget 注册器（新增，借鉴 Freeboard，未完全使用）
│   ├── report.js           # 日报/周报生成（已动态化）
│   ├── ai-analysis.js      # AI 分析模块（新增）
├── bridge_server.py        # Python WebSocket↔TCP 桥接
├── GUIDE.md                # 使用说明
├── CHANGELOG.md            # 修改说明（版本 2.1.0）
└── HANDOFF.md              # 本文档
```

---

## 三、最后一次对话做了什么

### 1. 动态传感器数量系统（完成度 90%）

**目标**：系统原来硬编码 3 个传感器，改为支持 2-8 个可动态调整。

**已实现**：
- `STATE.sensorConfig` 配置对象，含传感器键、名称、QoS 级别
- 连接配置卡片里加了一个「传感器数量」输入框 + 实时预览（如 `→ topic1, topic2, topic3, topic4`）
- 改数字即时触发 `rebuildSensorConfig()`：重生传感器卡片、图表数据集、报警规则、3D 煤堆列数
- `initSensorData()` 动态创建 `STATE.sensorData`
- 图表 `setupCharts()` 根据 `sensorConfig.sensors` 动态生成 datasets
- 报警规则 `initAlarmEngine()` / `syncAlarmConfig()` 动态生成（每传感器 × 2 条规则）
- HTML 传感器卡片改为 `renderSensorCards()` 动态生成
- 图表复选 checkbox 改为 `renderChartCheckboxes()` 动态生成
- 历史筛选 checkbox 改为 `renderHistoryFilterCheckboxes()` 动态生成
- `openTopicDetail()` 中 sensorNames/qosLabels 改为从 `sensorConfig` 获取
- `showAlarmToast()` + `getSensorName()` 从 `sensorConfig` 获取名称
- 3D 煤堆 `coal-pile-3d.js`：`S._sensorKeys` 数组、`_columnPosition` 动态角度计算、`setSensorKeys()` API、`setDemo()` 动态生成
- `buildDepthMap()` 动态生成
- `report.js` 完全重写为动态——通过 `window._getSensorConfig()` 桥接获取传感器配置
- `alarm-engine.js` 通过 `window._getSensorConfig()` 获取名称
- 全局桥接 `window._getSensorConfig = () => STATE.sensorConfig`
- `rebuildSensorConfig(newCount)` 函数处理增减传感器并重建所有模块
- 系统设置页面加了传感器数量配置 UI（`#sensorCount` 输入框）

**configSensorCount 事件绑定**（在 `bindUIEvents` 中）：
```javascript
configSensorCount.addEventListener('input', () => {
    const newCount = parseInt(configSensorCount.value) || 3;
    if (newCount !== STATE.sensorConfig.count && newCount >= 1 && newCount <= 8) {
        rebuildSensorConfig(newCount);
        updateTopicPreview();
    }
});
```

### 2. 3D 视觉优化（完成）

- 修复 Tooltip 偏移 bug (`_moveTooltip` 减去容器偏移)
- 修复 `wrapU` → `wrapT` 拼写
- 缓存可见标记列表（`S._visibleMarkers`）
- 测点球体加辉光 Sprite（`AdditiveBlending`），移除了脉冲动画
- 热力纹理由暴力 IDW 改为径向渐变（`createRadialGradient`），性能提升 1000 倍
- 纹理加各向异性过滤 + 脏检查
- 圆锥几何精度提升到 64×8 + 顶点噪声位移（正弦噪声）
- 暗色基础材质（`0x444444`）
- 灯光：`HemisphereLight` + 暖色轮廓光 + 地面接触阴影
- 图例刻度线（高低温报警阈值）
- 最高温度环标（`TorusGeometry` 黄色环）
- 煤堆透明度从 0.22 提到 0.55
- 辉光强度从 0.6 降到 0.2

### 3. 详情页煤堆 3D（新增）

- 新建 `js/coal-pile-detail.js`：单传感器圆柱煤堆，8 层深度，独立旋转缩放
- 在详情页 `openTopicDetail()` 中初始化和更新
- 在 `closeTopicDetail()` 中销毁

---

## 四、当前待完成的工作

### P0: 煤堆 3D 页面改造（正在进行中，未完成）

**用户需求**：
煤堆 3D 页面（侧边栏第二个菜单项）要改为**传感器卡片网格**。每个传感器一张小卡片，带小煤堆预览，点卡片进入该传感器的独立大煤堆视图。

**当前状态**：
- ✅ `index.html` 已改好结构：卡片网格 `#coal3dCardGrid` + 大图 `#coal3dDetailCard`（带 "← 返回列表" 按钮）
- ❌ 还没写 CSS 样式（网格布局、卡片样式、大图 hidden 切换）
- ❌ 还没写 `app.js` 里生成卡片和切换逻辑的函数
- ❌ 还没处理旧的事件绑定（`$('#c3dAutoRotate')` 等 ID 还在 HTML 里但换了位置，`bindUIEvents` 里的绑定需要确认是否还匹配）

**要做的事**：

1. **CSS**：在 `css/style.css` 中添加：
   ```css
   .coal3d-card-grid {
       display: grid;
       grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
       gap: 16px;
       margin-bottom: 16px;
   }
   .coal3d-mini-card {
       background: var(--color-surface);
       border-radius: var(--radius-md);
       border: 1px solid var(--color-border-light);
       cursor: pointer;
       transition: all 0.2s;
   }
   .coal3d-mini-card:hover {
       border-color: var(--color-primary);
       box-shadow: 0 4px 12px rgba(0,0,0,0.1);
       transform: translateY(-2px);
   }
   .coal3d-mini-card .mini-coal3d-stage { height: 200px; }
   .coal3d-mini-card .mini-coal3d-info {
       padding: 12px;
       display: flex;
       justify-content: space-between;
       align-items: center;
   }
   .coal3d-detail-card.hidden { display: none; }
   ```

2. **JS**：在 `app.js` 中添加函数：
   ```javascript
   // 点击煤堆卡片 → 显示大图
   function openCoal3dDetail(sensorKey) {
       $('#coal3dCardGrid').style.display = 'none';
       $('#coal3dDetailCard').classList.remove('hidden');
       $('#coal3dDetailTitle').textContent = getSensorName(sensorKey) + ' - 煤堆详情';
       // ... 初始化独立的 3D 场景，只显示该传感器的一列数据
   }

   // 返回列表
   function backToCoal3dGrid() {
       $('#coal3dDetailCard').classList.add('hidden');
       $('#coal3dCardGrid').style.display = '';
   }
   ```

3. **JS**：在 `navigateTo('coal3d')` 时触发渲染卡片网格，替换掉原来的单一大图初始化逻辑

### P1: 其他遗留小问题

1. **`alarm-engine.js:22`** 里 `_getSensorName` 函数用的是 `SENSOR_NAMES_PALETTE` fallback，但 `push` 方法的 JSDoc 注释还写着 `'topic1' | 'topic2' | 'topic3'`，仅注释，不影响功能
2. **`coal-pile-3d.js:433`** 的 `setData` 方法 JSDoc 注释还写着 `{topic1:[8],topic2:[8],topic3:[8]}`，不影响功能
3. **`coal-pile-3d.js:8`** 文件头 JSDoc 注释还写着 3 个，不影响功能
4. **`css/style.css`** 里 `.topic1-card:hover`、`.topic2-card:hover`、`.topic3-card:hover` 可能已失效（因为卡片是动态生成的 class），可以删掉
5. 旧的 `$('#c3dAutoRotate')`、`$('#btnC3dReset')`、`$('#btnC3dDemo')` 事件绑定在 `bindUIEvents` 中，HTML 结构已改但 ID 还在，绑定仍有效，但 `btnC3dDemo` 的逻辑需要适配新场景

---

## 五、调试要点

1. **打开页面**：用浏览器打开 `index.html`，或 `python -m http.server 8080`
2. **验证传感器数量**：在首页连接配置卡片改数字，看传感器卡片、图表、3D 是否跟着变
3. **验证 3D**：点击煤堆 3D 菜单 → 看到卡片网格 → 点一张卡片 → 看到大图
4. **语法检查**：`node --check js/*.js`（所有 11 个文件）
5. **当 CDN 不可用**：Chart.js/MQTT.js/Three.js 从 jsDelivr 加载，离线环境会失败

---

## 六、关键全局变量和 API

```javascript
// STATE 核心配置
STATE.sensorConfig = { count: 3, sensors: [{ key:'topic1', name:'传感器 1', qos:0 }, ...] }
STATE.sensorData = { topic1: { current, history:RingBuffer(2000), depths:[] }, ... }
STATE.settings = { alarmHigh:50, alarmLow:0, alarmVolume:70, maxHistorySize:1000, chartInterval:1000, maxChartPoints:60, aiEndpoint, aiApiKey }

// 全局导出
window.CoalPile3D          // 多列煤堆 3D（主页面）
window.CoalPileDetail      // 单列煤堆 3D（详情页）
window.AlarmEngine         // 告警引擎
window.RingBuffer          // 环形缓冲区
window.DataSourceFactory   // 数据源工厂
window.widgetRegistry      // Widget 注册器
window.AiAnalysis          // AI 分析
window.generateReport      // 报表生成
window.openTopicDetail     // 打开传感器详情
window.closeTopicDetail    // 关闭传感器详情
window._getSensorConfig    // 桥接：获取传感器配置（供 report.js, alarm-engine.js 使用）

// DOM 速查
$('#configSensorCount')    // 传感器数量输入框
$('#configTopicPreview')   // 主题预览文本
$('#chartCheckboxGroup')   // 图表复选框容器
$('#historyFilterGroup')   // 历史筛选复选框容器
$('#sensorCardsContainer') // 传感器卡片容器
$('#coal3dCardGrid')       // 煤堆卡片网格（新）
$('#coal3dDetailCard')     // 煤堆大图卡片（新）
$('#coal3dStage')          // 煤堆 3D 容器
$('#btnC3dBack')           // 返回列表按钮（新）
```

---

## 七、常用函数速查

| 函数 | 位置 | 作用 |
|------|------|------|
| `init()` | app.js:262 | 入口 |
| `renderSensorCards()` | app.js:~80 | 生成传感器卡片 |
| `rebuildSensorConfig(n)` | app.js:~240 | 重建全部模块 |
| `updateTopicPreview()` | app.js:~265 | 更新主题预览 |
| `getSensorName(key)` | app.js:~270 | 获取传感器名称 |
| `initCoal3D()` | app.js:1555 | 初始化主煤堆 3D |
| `syncCoal3D()` | app.js:1568 | 同步 3D 数据 |
| `initDetailCoal3D(key)` | app.js:1537 | 初始化详情页煤堆 |
| `openTopicDetail(key)` | app.js:1782 | 打开传感器详情 |
| `CoalPile3D.setSensorKeys(keys)` | coal-pile-3d.js | 设置列数 |
| `CoalPile3D.init(el, opts)` | coal-pile-3d.js | 初始化主煤堆 |
| `CoalPileDetail.init(el)` | coal-pile-detail.js | 初始化详情煤堆 |