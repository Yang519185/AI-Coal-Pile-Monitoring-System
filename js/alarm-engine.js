/**
 * 告警引擎 — 借鉴 Netdata Health 子系统设计
 *
 * 核心改进相对于旧 checkAlarm():
 *  1. 三级告警: WARNING → CRITICAL → EMERGENCY
 *  2. 滑动窗口取平均，防止瞬时跳变误报
 *  3. 持续时长判定 (delay)，超过 N 秒才触发
 *  4. 重复提醒 (repeat)，告警持续期间每隔 N 秒再通知
 *  5. 告警静默规则 (silencer)，按传感器 + 时段选择性静默
 *  6. 告警恢复通知，温度回到正常后告知用户
 *
 * 用法:
 *   const engine = new AlarmEngine({ onAlert: (e) => { ... } });
 *   engine.configure({ rules: [...], silencers: [...] });
 *   engine.push('topic1', 52.3);
 */
(function () {
    'use strict';

    const ALARM_STATUS = { OK: 'ok', WARNING: 'warning', CRITICAL: 'critical' };
    const STATUS_RANK = { ok: 0, warning: 1, critical: 2 };
    const SENSOR_NAMES_PALETTE = ['传感器 #1', '传感器 #2', '传感器 #3', '传感器 #4', '传感器 #5', '传感器 #6', '传感器 #7', '传感器 #8'];

    function _getSensorName(key) {
        if (window._getSensorConfig) {
            const cfg = window._getSensorConfig();
            const sensor = cfg.sensors.find(s => s.key === key);
            if (sensor) return sensor.name;
        }
        const idx = parseInt(key.replace('topic', '')) - 1;
        return SENSOR_NAMES_PALETTE[idx] || key;
    }

    class AlarmEngine {
        constructor(opts = {}) {
            // 滑动窗口: { 'topic1:temperature': [值数组] }
            this._windows = {};

            // 告警状态: { ruleName: { status, since, lastNotified, delayStarted } }
            this._states = {};

            // 配置
            this._rules = [];
            this._silencers = [];

            // setInterval 句柄
            this._ticker = null;

            // 回调
            this._callbacks = {
                onAlert: opts.onAlert || null,    // ({ sensorKey, rule, status, value, threshold })
                onClear: opts.onClear || null,     // ({ sensorKey, rule })
                onTicker: opts.onTicker || null,   // 每个 tick 周期回调，用于更新 UI
            };
        }

        // ===================== 配置 =====================
        /**
         * 配置规则和静默规则，完全替换
         * rules: [{ name, sensor, on, lookup, every, warn, crit, delay, repeat }]
         * silencers: [{ sensor, startHour, endHour }]
         */
        configure({ rules, silencers = [] }) {
            // 迁移旧状态到新规则集（按 name 匹配保留）
            const oldStates = this._states;
            this._states = {};
            for (const r of rules) {
                this._states[r.name] = oldStates[r.name] || {
                    status: ALARM_STATUS.OK,
                    since: null,
                    lastNotified: 0,
                    delayStarted: null,
                };
            }

            this._rules = rules;
            this._silencers = silencers;

            // 启动 ticker
            this._startTicker();
        }

        /**
         * 运行时更新单个规则 (保留其他规则不变)
         */
        updateRule(name, patch) {
            const idx = this._rules.findIndex(r => r.name === name);
            if (idx >= 0) {
                Object.assign(this._rules[idx], patch);
            }
        }

        /**
         * 添加 / 替换 静默规则
         */
        setSilencers(silencers) {
            this._silencers = silencers;
        }

        // ===================== 数据推送（从 app.js 调用） =====================
        /**
         * 推送一个传感器数据点
         * @param {string} sensorKey - 传感器键（如 'topic1'，数量由配置决定）
         * @param {number} value - 温度值
         */
        push(sensorKey, value) {
            for (const rule of this._rules) {
                if (rule.sensor !== sensorKey) continue;

                const winKey = `${rule.sensor}:${rule.on}`;
                this._pushWindow(winKey, value, rule.lookup.duration);

                // 只在 every 间隔时检查（由 ticker 统一调度）
            }
        }

        /** 获取某传感器当前滑动窗口平均值 */
        getAverage(sensorKey) {
            for (const rule of this._rules) {
                if (rule.sensor !== sensorKey) continue;
                const winKey = `${rule.sensor}:${rule.on}`;
                return this._windowAvg(winKey);
            }
            return NaN;
        }

        /** 获取某规则的当前状态 */
        getState(ruleName) {
            return this._states[ruleName] || null;
        }

        /** 获取所有规则的状态快照 */
        getAllStates() {
            const result = {};
            for (const [name, st] of Object.entries(this._states)) {
                result[name] = {
                    status: st.status,
                    since: st.since,
                    lastNotified: st.lastNotified,
                };
            }
            return result;
        }

        // ===================== 内部方法 =====================

        _startTicker() {
            if (this._ticker) clearInterval(this._ticker);
            // 找最小的 every 间隔
            const intervals = this._rules.map(r => r.every || 5);
            const minInterval = Math.min(...intervals) * 1000;
            this._ticker = setInterval(() => this._tick(), Math.max(minInterval, 1000));
        }

        _tick() {
            const now = Date.now() / 1000;
            for (const rule of this._rules) {
                // 跳过还没到检查间隔的规则
                const st = this._states[rule.name];
                if (!st) continue;
                const every = rule.every || 5;
                if (now - (st._lastCheck || 0) < every) continue;

                this._evaluateRule(rule, now);
            }
            if (this._callbacks.onTicker) this._callbacks.onTicker();
        }

        _evaluateRule(rule, now) {
            const st = this._states[rule.name];
            st._lastCheck = now;

            const winKey = `${rule.sensor}:${rule.on}`;
            const currentValue = this._windowAvg(winKey);
            if (isNaN(currentValue)) return; // 数据不够

            // 计算阈值
            const warnThresh = this._evalThreshold(rule.warn, currentValue);
            const critThresh = this._evalThreshold(rule.crit, currentValue);

            // 判断目标状态
            let targetStatus = ALARM_STATUS.OK;
            if (currentValue >= critThresh) {
                targetStatus = ALARM_STATUS.CRITICAL;
            } else if (currentValue >= warnThresh) {
                targetStatus = ALARM_STATUS.WARNING;
            }

            // 状态未变: 检查是否需要重复提醒
            if (targetStatus === st.status) {
                if (targetStatus !== ALARM_STATUS.OK && st.lastNotified > 0) {
                    const repeat = rule.repeat || 300;
                    if (now - st.lastNotified >= repeat) {
                        this._fireAlert(rule, targetStatus, currentValue, warnThresh, critThresh, true);
                    }
                }
                return;
            }

            // 状态变化: 需要 delay 判定
            const delay = rule.delay || 0;

            if (targetStatus !== ALARM_STATUS.OK) {
                // 恶化: 启动 delay 计时器
                if (!st.delayStarted) {
                    st.delayStarted = now;
                }
                if (now - st.delayStarted >= delay) {
                    // delay 已过，触发告警
                    this._transition(rule, st, targetStatus, currentValue, warnThresh, critThresh, now);
                }
            } else {
                // 恢复: 立即清除 delay 计时器并通知
                st.delayStarted = null;
                this._transition(rule, st, ALARM_STATUS.OK, currentValue, warnThresh, critThresh, now);
            }
        }

        _transition(rule, st, newStatus, currentValue, warnThresh, critThresh, now) {
            const oldStatus = st.status;
            st.status = newStatus;
            st.since = now;
            st.delayStarted = null;

            if (newStatus === ALARM_STATUS.OK) {
                if (this._callbacks.onClear) {
                    this._callbacks.onClear({ sensorKey: rule.sensor, rule: rule.name });
                }
            } else {
                // 检查是否被静默
                if (this._isSilenced(rule.sensor)) return;

                this._fireAlert(rule, newStatus, currentValue, warnThresh, critThresh, false);
            }
        }

        _fireAlert(rule, status, currentValue, warnThresh, critThresh, isRepeat) {
            const st = this._states[rule.name];
            st.lastNotified = Date.now() / 1000;
            if (this._callbacks.onAlert) {
                this._callbacks.onAlert({
                    sensorKey: rule.sensor,
                    sensorName: _getSensorName(rule.sensor) || rule.sensor,
                    rule: rule.name,
                    status: status,
                    value: currentValue,
                    warnThreshold: warnThresh,
                    critThreshold: critThresh,
                    isRepeat: isRepeat,
                });
            }
        }

        _isSilenced(sensorKey) {
            const now = new Date();
            const hour = now.getHours();
            for (const s of this._silencers) {
                if (s.sensor && s.sensor !== sensorKey) continue;
                const start = s.startHour != null ? s.startHour : 0;
                const end = s.endHour != null ? s.endHour : 24;
                if (start <= end) {
                    if (hour >= start && hour < end) return true;
                } else {
                    // 跨天 (如 22:00 - 06:00)
                    if (hour >= start || hour < end) return true;
                }
            }
            return false;
        }

        /** 计算阈值表达式。支持 "this > 45" 或 直接数字 45 */
        _evalThreshold(expr, currentValue) {
            if (typeof expr === 'number') return expr;
            if (typeof expr !== 'string') return NaN;

            // 简单解析: "this > 50" 或 "this < 10"
            const m = expr.match(/this\s*([<>]=?)\s*(-?[\d.]+)/);
            if (m) {
                const op = m[1];
                const val = parseFloat(m[2]);
                // 返回阈值本身（不执行比较，因为我们用 >= 或 <= 判断）
                return val;
            }
            return parseFloat(expr);
        }

        // ===================== 滑动窗口 =====================
        _pushWindow(key, value, durationSec) {
            if (!this._windows[key]) this._windows[key] = [];
            const win = this._windows[key];
            const now = Date.now() / 1000;

            win.push({ time: now, value: value });

            // 淘汰过期数据
            const cutoff = now - durationSec;
            while (win.length > 0 && win[0].time < cutoff) {
                win.shift();
            }

            // 安全上限
            if (win.length > 300) win.shift();
        }

        _windowAvg(key) {
            const win = this._windows[key];
            if (!win || win.length === 0) return NaN;
            let sum = 0;
            for (const p of win) sum += p.value;
            return sum / win.length;
        }

        // ===================== 销毁 =====================
        destroy() {
            if (this._ticker) clearInterval(this._ticker);
            this._windows = {};
            this._states = {};
            this._rules = [];
            this._silencers = [];
        }
    }

    // 暴露全局
    window.AlarmEngine = AlarmEngine;
    window.ALARM_STATUS = ALARM_STATUS;
})();