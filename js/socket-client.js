/**
 * WebSocket / TCP 客户端模块
 * 用于网口直连模式
 */
class SocketClientWrapper {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.autoReconnect = true;
        this.callbacks = {
            onMessage: null,
            onConnect: null,
            onDisconnect: null,
            onError: null,
            onLog: null
        };
    }

    /**
     * 连接到服务器
     * @param {Object} config - { host, port, protocol, format }
     */
    connect(config) {
        const { host, port, protocol, format } = config;

        if (protocol === 'tcp') {
            this._log('warn', '浏览器不支持原生 TCP Socket，将使用 WebSocket 连接');
            this._log('info', '提示：如需 TCP 直连，请在后端部署 WebSocket-TCP 桥接服务');
        }

        // 构建 WebSocket URL
        const wsUrl = `ws://${host}:${port}`;
        this._log('info', `正在连接: ${wsUrl}`);
        this._format = format || 'json';

        try {
            this.socket = new WebSocket(wsUrl);

            this.socket.onopen = () => {
                this.connected = true;
                this._log('info', '✓ 网口连接成功');
                if (this.callbacks.onConnect) this.callbacks.onConnect();
            };

            this.socket.onmessage = (event) => {
                const raw = event.data;
                this._log('data', `收到: ${raw.substring(0, 100)}${raw.length > 100 ? '...' : ''}`);

                let parsed = null;
                if (this._format === 'json') {
                    try {
                        parsed = JSON.parse(raw);
                    } catch (e) {
                        parsed = { raw };
                    }
                } else if (this._format === 'csv') {
                    parsed = this._parseCsv(raw);
                } else {
                    parsed = { raw };
                }

                if (this.callbacks.onMessage) {
                    this.callbacks.onMessage({
                        topic: 'socket',
                        payload: parsed,
                        raw,
                        timestamp: Date.now()
                    });
                }
            };

            this.socket.onclose = (event) => {
                this.connected = false;
                this._log('warn', `连接已关闭 (code: ${event.code})`);
                if (this.callbacks.onDisconnect) this.callbacks.onDisconnect();

                // 自动重连
                if (this.autoReconnect) {
                    this._scheduleReconnect(config);
                }
            };

            this.socket.onerror = (err) => {
                this._log('error', 'WebSocket 连接错误');
                if (this.callbacks.onError) this.callbacks.onError(err);
            };

        } catch (err) {
            this._log('error', `初始化失败: ${err.message}`);
            if (this.callbacks.onError) this.callbacks.onError(err);
        }
    }

    /**
     * 发送数据
     */
    send(data) {
        if (!this.socket || !this.connected) {
            this._log('error', '未连接，无法发送数据');
            return;
        }
        const payload = typeof data === 'object' ? JSON.stringify(data) : String(data);
        this.socket.send(payload);
        this._log('info', `已发送: ${payload.substring(0, 60)}${payload.length > 60 ? '...' : ''}`);
    }

    /**
     * 断开连接
     */
    disconnect() {
        this.autoReconnect = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.socket) {
            this.socket.close(1000, '用户主动断开');
            this.connected = false;
            this._log('info', '已断开网口连接');
        }
    }

    isConnected() {
        return this.connected;
    }

    /**
     * 解析 CSV 格式数据
     */
    _parseCsv(raw) {
        const lines = raw.trim().split('\n');
        if (lines.length < 2) return { raw };

        const headers = lines[0].split(',').map(h => h.trim());
        const values = lines[lines.length - 1].split(',').map(v => v.trim());
        const result = {};
        headers.forEach((h, i) => {
            const num = parseFloat(values[i]);
            result[h] = isNaN(num) ? values[i] : num;
        });
        return result;
    }

    _scheduleReconnect(config) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this._log('info', '5秒后自动重连...');
        this.reconnectTimer = setTimeout(() => {
            this._log('info', '正在重连...');
            this.connect(config);
        }, 5000);
    }

    _log(level, message) {
        if (this.callbacks.onLog) {
            this.callbacks.onLog({ level, message, timestamp: Date.now() });
        }
    }
}
