# IoT 温度监控平台 - Web 仪表盘

## 功能概述

基于 Web 技术构建的嵌入式设备远程温度监测仪表盘，支持两种数据接入模式。

### 两种连接模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| **EMQX 服务器** | 通过 MQTT over WebSocket 连接 EMQX 代理 | 设备已接入 EMQX 平台，远程监控 |
| **网口直连** | 通过 WebSocket 桥接 TCP 直连设备 | 局域网内直接连接嵌入式设备 |

### 主要功能

- **实时温度曲线** — 3 路传感器并行显示，Chart.js 渲染
- **传感器卡片** — 大字体温度数值 + 渐变色温度条
- **报警系统** — 可配置高/低温阈值，超限声音 + 弹窗报警
- **历史数据** — 数据记录、统计（最大/最小/平均）、表格查看
- **CSV 导出** — 一键导出历史数据为 CSV 文件
- **消息日志** — 实时显示数据流，类似控制台终端
- **系统设置** — 报警阈值、图表参数、AI 分析 API 配置
- **响应式设计** — 支持 PC、平板、手机

## 快速开始

### 方式一：直接打开（EMQX 模式）

```bash
# 1. 直接用浏览器打开
# Chrome / Edge / Firefox 打开 index.html

# 或使用简单的 HTTP 服务器
cd web_dashboard
python -m http.server 8080

# 2. 浏览器访问 http://localhost:8080
# 3. 选择 "EMQX 服务器" 模式，点击连接
#    默认连接 broker.emqx.io:8083，订阅 topic1
```

### 方式二：网口直连模式

```bash
# 1. 安装 Python 依赖
pip install websockets

# 2. 启动桥接服务器
python bridge_server.py --ws-port 9000 --tcp-host 192.168.1.100 --tcp-port 8080

# 3. 打开 index.html
# 4. 选择 "网口直连" 模式
#    服务器地址: localhost
#    端口号: 9000
#    点击连接
```

### 方式三：部署到嵌入式设备

将整个 `web_dashboard` 目录复制到设备的 Web 服务器目录：

```bash
# 例如 STM32MP157 (如果运行了 lighttpd/nginx)
scp -r web_dashboard/* root@192.168.1.100:/var/www/html/
```

## 技术栈

| 技术 | 用途 |
|------|------|
| HTML5 / CSS3 | 页面结构与样式 |
| Chart.js 4.x | 实时温度曲线图 |
| MQTT.js 5.x | MQTT over WebSocket 客户端 |
| WebSocket API | 网口直连通信 |
| Python 3 + websockets | TCP-WebSocket 桥接服务器 |

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + 1` | 切换到 EMQX 模式 |
| `Ctrl + 2` | 切换到网口直连模式 |
| `Ctrl + Enter` | 连接 / 断开 |

## 项目结构

```
web_dashboard/
├── index.html              # 主页面 (SPA)
├── css/
│   └── style.css           # 样式表 (企业仪表盘风格)
├── js/
│   ├── app.js              # 主应用逻辑
│   ├── mqtt-client.js      # MQTT 客户端封装
│   └── socket-client.js    # WebSocket 客户端封装
├── bridge_server.py        # TCP-WebSocket 桥接服务器
└── README.md               # 本文件
```
