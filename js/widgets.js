/**
 * Widget 注册器 — 借鉴 Freeboard 面板架构
 *
 * 每个传感器卡片 / 图表 / 状态指示器 作为一个独立 Widget 注册。
 * Widget 自己负责渲染和更新，app.js 不再直接操作 DOM。
 * 加第 N 个传感器只需 widgetRegistry.create('sensor-card', ...)
 *
 * 用法:
 *   const w = widgetRegistry.create('sensor-card', '#container', { id:'s4', title:'传感器 #4' });
 *   w.update({ temperature: 23.5, battery: 85, pressure: 12.3 });
 */
(function () {
    'use strict';

    /** 温度条百分比（共用的纯函数） */
    function tempBarPct(temp, min, max) {
        return Math.max(0, Math.min(100, ((temp - min) / (max - min)) * 100));
    }

    // ===================== Widget 基类 =====================
    class Widget {
        constructor(container, config) {
            this.container = typeof container === 'string'
                ? document.querySelector(container)
                : container;
            this.config = config || {};
            this.el = null;
        }

        /** 渲染 DOM 到容器 */
        render() { throw new Error('Not implemented'); }

        /** 更新数据和显示 */
        update(data) { /* 子类按需重写 */ }

        /** 销毁 */
        destroy() {
            if (this.el && this.el.parentNode) {
                this.el.parentNode.removeChild(this.el);
            }
            this.el = null;
        }
    }

    // ===================== 传感器卡片 Widget =====================
    class SensorCardWidget extends Widget {
        render() {
            const { id, title, topic, qos } = this.config;
            const sensorIdx = parseInt(id.replace('sensor', '')) || 1;

            this.el = document.createElement('div');
            this.el.className = 'card data-card clickable-card';
            this.el.setAttribute('data-sensor', topic);
            this.el.onclick = () => {
                if (typeof window.openTopicDetail === 'function') {
                    window.openTopicDetail(topic);
                }
            };
            this.el.innerHTML = `
                <div class="card-header">
                    <h3 class="card-title">${title || '传感器'}</h3>
                    <span class="badge badge-qos">${qos || 'QoS 0'}</span>
                </div>
                <div class="card-body">
                    <div class="sensor-meter">
                        <div class="meter-main">
                            <div class="meter-tempwrap">
                                <div class="data-value-large" id="${id}Temp">--.-</div>
                                <div class="data-unit">°C</div>
                            </div>
                            <div class="meter-minis">
                                <div class="mini-item">
                                    <span class="mini-label">电池</span>
                                    <span class="mini-value" id="${id}Bat">--%</span>
                                </div>
                                <div class="mini-item">
                                    <span class="mini-label">压力</span>
                                    <span class="mini-value" id="${id}Press">-- kg</span>
                                </div>
                            </div>
                        </div>
                        <div class="data-bar" title="量程 -10 ~ 70°C">
                            <div class="data-bar-inner-fill" id="${id}Bar" style="width: 0%"></div>
                            <div class="data-bar-needle" id="${id}Needle" style="left: 12.5%"></div>
                        </div>
                        <div class="data-range">
                            <span>-10</span><span>0</span><span>30</span><span>70</span>
                        </div>
                        <div class="meter-footer">
                            <span class="mf-topic">${topic}</span>
                            <span class="mf-action">详情 →</span>
                        </div>
                    </div>
                </div>`;

            if (this.container) {
                this.container.appendChild(this.el);
            }
            return this;
        }

        update(data) {
            const { id } = this.config;
            const temp = data.temperature;
            const battery = data.battery;
            const pressure = data.pressure;
            const alarmHigh = data.alarmHigh || 50;
            const alarmLow = data.alarmLow || 0;

            // 温度显示：整数大数字 + 小数降级，仪表感更强
            const tempEl = document.getElementById(`${id}Temp`);
            if (tempEl) {
                if (temp != null && !isNaN(temp)) {
                    const fixed = temp.toFixed(1);
                    const parts = fixed.split('.');
                    const intPart = parts[0];
                    const decPart = parts.length > 1 ? parts[1] : '0';
                    tempEl.innerHTML =
                        `${intPart}<span class="temp-decimal">.${decPart}</span>`;
                    tempEl.classList.remove('alarm-high', 'alarm-low');
                    if (temp >= alarmHigh) tempEl.classList.add('alarm-high');
                    else if (temp <= alarmLow) tempEl.classList.add('alarm-low');
                } else {
                    tempEl.textContent = '--.-';
                    tempEl.classList.remove('alarm-high', 'alarm-low');
                }
            }

            // 温度轨：填充按百分比从左生长，游标指示当前值
            const barEl = document.getElementById(`${id}Bar`);
            const needleEl = document.getElementById(`${id}Needle`);
            if (temp != null && !isNaN(temp)) {
                const pct = tempBarPct(temp, -10, 70);
                if (barEl) barEl.style.width = `${pct}%`;
                if (needleEl) needleEl.style.left = `${pct}%`;
            }

            // 电池
            const batEl = document.getElementById(`${id}Bat`);
            if (batEl) {
                if (battery != null && !isNaN(battery)) {
                    const b = parseInt(battery);
                    batEl.textContent = `${b}%`;
                    batEl.classList.remove('meta-low', 'meta-warn');
                    if (b <= 20) batEl.classList.add('meta-low');
                    else if (b <= 50) batEl.classList.add('meta-warn');
                } else {
                    batEl.textContent = '--%';
                }
            }

            // 压力
            const pressEl = document.getElementById(`${id}Press`);
            if (pressEl) {
                if (pressure != null && !isNaN(pressure)) {
                    pressEl.textContent = `${parseFloat(pressure).toFixed(1)} kg`;
                } else {
                    pressEl.textContent = '-- kg';
                }
            }
        }
    }

    // ===================== 图表 Widget =====================
    class ChartWidget extends Widget {
        render() {
            const { id, chartType } = this.config;

            this.el = document.createElement('div');
            this.el.className = 'card chart-card';
            this.el.innerHTML = `
                <div class="card-header">
                    <h3 class="card-title">${this.config.title || '图表'}</h3>
                    <div class="chart-controls" id="${id}Controls"></div>
                </div>
                <div class="card-body">
                    <div class="chart-container">
                        <canvas id="${id}Canvas"></canvas>
                    </div>
                </div>`;

            if (this.container) {
                this.container.appendChild(this.el);
            }

            this._chart = null;
            return this;
        }

        /** 获取内部 canvas 上下文 */
        getCanvas() {
            return document.getElementById(`${this.config.id}Canvas`);
        }
    }

    // ===================== 告警状态指示器 Widget =====================
    class AlarmIndicatorWidget extends Widget {
        render() {
            const { id } = this.config;
            this.el = document.createElement('div');
            this.el.className = 'alarm-indicator';
            this.el.id = id;
            this.el.innerHTML = '<span class="alarm-indicator-text" id="alarmIndicatorText">监控正常</span>';
            if (this.container) {
                this.container.appendChild(this.el);
            }
            return this;
        }

        update(data) {
            const text = document.getElementById('alarmIndicatorText');
            if (!text) return;
            const { activeCount, highestStatus } = data;
            if (activeCount > 0) {
                text.textContent = highestStatus === 'critical'
                    ? `🔴 ${activeCount} 个告警活跃`
                    : `🟡 ${activeCount} 个预警活跃`;
            } else {
                text.textContent = '✅ 监控正常';
            }
        }
    }

    // ===================== Widget 注册器 =====================
    const widgetRegistry = {
        _types: {
            'sensor-card': SensorCardWidget,
            'chart': ChartWidget,
            'alarm-indicator': AlarmIndicatorWidget,
        },

        /** 注册新 Widget 类型 */
        register(name, WidgetClass) {
            this._types[name] = WidgetClass;
        },

        /** 创建 Widget 实例（不自动 render，方便后续配置） */
        create(name, container, config) {
            const Cls = this._types[name];
            if (!Cls) throw new Error(`未知 Widget 类型: ${name}`);
            return new Cls(container, config);
        },

        /** 创建并立即渲染 */
        createAndRender(name, container, config) {
            const widget = this.create(name, container, config);
            return widget.render();
        },

        /** 列出可用类型 */
        list() {
            return Object.keys(this._types);
        },
    };

    window.Widget = Widget;
    window.widgetRegistry = widgetRegistry;
})();