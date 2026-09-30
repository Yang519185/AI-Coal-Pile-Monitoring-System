/**
 * 数据源统一接口 — 借鉴 Freeboard 插件模式
 *
 * 所有协议适配器实现同一接口，app.js 不再需要 if-else 分支。
 * 新增协议（Modbus、OPC-UA、HTTP Polling 等）只需注册适配器即可。
 *
 * 用法:
 *   const ds = DataSourceFactory.create('emqx');
 *   ds.on('message', (data) => { ... });
 *   ds.on('status', (state) => { ... });  // 'connecting'|'connected'|'disconnected'|'error'
 *   ds.on('log', (entry) => { ... });
 *   ds.connect(config);
 *   ds.disconnect();
 */
(function () {
    'use strict';

    /**
     * EventEmitter — 轻量事件总线
     */
    class EventEmitter {
        constructor() { this._listeners = {}; }
        on(event, fn) {
            if (!this._listeners[event]) this._listeners[event] = [];
            this._listeners[event].push(fn);
            return this;
        }
        off(event, fn) {
            const list = this._listeners[event];
            if (list) {
                const idx = list.indexOf(fn);
                if (idx >= 0) list.splice(idx, 1);
            }
            return this;
        }
        emit(event, ...args) {
            const list = this._listeners[event];
            if (list) list.forEach(fn => { try { fn(...args); } catch (e) { /* 不中断其他监听器 */ } });
            return this;
        }
        removeAllListeners() { this._listeners = {}; }
    }

    /**
     * 数据源基类 — 所有适配器继承此基类
     */
    class DataSource extends EventEmitter {
        constructor(id) {
            super();
            this.id = id;
            this.connected = false;
        }

        /** 子类必须重写 */
        connect(config) { throw new Error('Not implemented'); }
        disconnect() { throw new Error('Not implemented'); }

        /** 发送数据到设备 */
        send(data) { /* 可选，子类按需重写 */ }

        /** 更新连接状态并通知 */
        _setStatus(status) {
            this.emit('status', status);
        }
    }

    /**
     * EMQX MQTT 适配器 — 包装 MqttClientWrapper
     */
    class EmqxAdapter extends DataSource {
        constructor() {
            super('emqx');
            this._wrapper = new MqttClientWrapper();
        }

        connect(config) {
            const wrapper = this._wrapper;

            wrapper.callbacks = {
                onMessage: (data) => {
                    this.emit('message', data);
                },
                onConnect: () => {
                    this.connected = true;
                    this._setStatus('connected');
                },
                onDisconnect: () => {
                    this.connected = false;
                    this._setStatus('disconnected');
                },
                onError: (err) => {
                    this._setStatus('error');
                    this.emit('log', { level: 'error', message: `MQTT 错误: ${err.message || err}` });
                },
                onLog: (entry) => {
                    this.emit('log', entry);
                },
            };

            this._setStatus('connecting');
            wrapper.connect(config);
        }

        disconnect() {
            this._wrapper.disconnect();
        }
    }

    /**
     * WebSocket / TCP 直连适配器 — 包装 SocketClientWrapper
     */
    class SocketAdapter extends DataSource {
        constructor() {
            super('socket');
            this._wrapper = new SocketClientWrapper();
        }

        connect(config) {
            const wrapper = this._wrapper;

            wrapper.callbacks = {
                onMessage: (data) => {
                    this.emit('message', data);
                },
                onConnect: () => {
                    this.connected = true;
                    this._setStatus('connected');
                },
                onDisconnect: () => {
                    this.connected = false;
                    this._setStatus('disconnected');
                },
                onError: (err) => {
                    this._setStatus('error');
                    this.emit('log', { level: 'error', message: `Socket 错误: ${err.message || err}` });
                },
                onLog: (entry) => {
                    this.emit('log', entry);
                },
            };

            this._setStatus('connecting');
            wrapper.connect(config);
        }

        disconnect() {
            this._wrapper.disconnect();
        }
    }

    /**
     * 数据源工厂
     */
    const DataSourceFactory = {
        _adapters: {
            emqx: EmqxAdapter,
            socket: SocketAdapter,
        },

        /** 注册自定义适配器 */
        register(name, AdapterClass) {
            this._adapters[name] = AdapterClass;
        },

        /** 创建数据源实例 */
        create(name) {
            const Adapter = this._adapters[name];
            if (!Adapter) throw new Error(`未知数据源类型: ${name}`);
            return new Adapter();
        },

        /** 列出可用适配器 */
        list() {
            return Object.keys(this._adapters);
        },
    };

    // 暴露全局
    window.DataSource = DataSource;
    window.DataSourceFactory = DataSourceFactory;
})();