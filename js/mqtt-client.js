/**
 * MQTT 客户端模块
 * 基于 MQTT.js 封装，用于连接 EMQX 服务器
 */
class MqttClientWrapper {
    constructor() {
        this.client = null;
        this.connected = false;
        this.callbacks = {
            onMessage: null,
            onConnect: null,
            onDisconnect: null,
            onError: null,
            onLog: null
        };
    }

    /**
     * 连接到 EMQX 服务器
     * @param {Object} config - { host, port, clientId, username, password, topics }
     */
    connect(config) {
        const { host, port, clientId, username, password, topics } = config;

        // 构建 WebSocket URL
        const wsUrl = `ws://${host}:${port}/mqtt`;

        this._log('info', `正在连接 EMQX 服务器: ${wsUrl}`);

        const options = {
            clientId: clientId || `web_dashboard_${Math.random().toString(36).substring(2, 12)}`,
            clean: true,
            reconnectPeriod: 5000,
            connectTimeout: 10000,
        };

        if (username) options.username = username;
        if (password) options.password = password;

        try {
            this.client = mqtt.connect(wsUrl, options);

            this.client.on('connect', () => {
                this.connected = true;
                this._log('info', '✓ EMQX 连接成功');

                // 订阅主题
                if (topics && topics.length > 0) {
                    const topicList = topics.map(t => typeof t === 'string' ? t : t.topic);
                    this.client.subscribe(topicList, { qos: 0 }, (err) => {
                        if (err) {
                            this._log('error', `订阅失败: ${err.message}`);
                        } else {
                            this._log('info', `已订阅主题: ${topicList.join(', ')}`);
                        }
                    });
                }

                if (this.callbacks.onConnect) this.callbacks.onConnect();
            });

            this.client.on('message', (topic, message) => {
                const payload = message.toString();
                this._log('data', `[${topic}] ${payload}`);

                let parsed = null;
                try {
                    parsed = JSON.parse(payload);
                } catch (e) {
                    parsed = { raw: payload };
                }

                if (this.callbacks.onMessage) {
                    this.callbacks.onMessage({ topic, payload: parsed, raw: payload, timestamp: Date.now() });
                }
            });

            this.client.on('reconnect', () => {
                this._log('warn', '正在重连...');
            });

            this.client.on('close', () => {
                this.connected = false;
                this._log('warn', '连接已关闭');
                if (this.callbacks.onDisconnect) this.callbacks.onDisconnect();
            });

            this.client.on('error', (err) => {
                this._log('error', `连接错误: ${err.message}`);
                if (this.callbacks.onError) this.callbacks.onError(err);
            });

            this.client.on('offline', () => {
                this.connected = false;
                this._log('warn', '客户端离线');
            });

        } catch (err) {
            this._log('error', `初始化失败: ${err.message}`);
            if (this.callbacks.onError) this.callbacks.onError(err);
        }
    }

    /**
     * 发布消息
     */
    publish(topic, message, qos = 0) {
        if (!this.client || !this.connected) {
            this._log('error', '未连接，无法发布消息');
            return;
        }
        const payload = typeof message === 'object' ? JSON.stringify(message) : String(message);
        this.client.publish(topic, payload, { qos }, (err) => {
            if (err) {
                this._log('error', `发布失败: ${err.message}`);
            } else {
                this._log('info', `已发布 → ${topic}`);
            }
        });
    }

    /**
     * 订阅主题
     */
    subscribe(topics) {
        if (!this.client || !this.connected) return;
        const topicList = Array.isArray(topics) ? topics : [topics];
        this.client.subscribe(topicList, { qos: 0 }, (err) => {
            if (err) {
                this._log('error', `订阅失败: ${err.message}`);
            } else {
                this._log('info', `已订阅: ${topicList.join(', ')}`);
            }
        });
    }

    /**
     * 断开连接
     */
    disconnect() {
        if (this.client) {
            this.client.end(true);
            this.connected = false;
            this._log('info', '已断开 EMQX 连接');
        }
    }

    isConnected() {
        return this.connected;
    }

    _log(level, message) {
        if (this.callbacks.onLog) {
            this.callbacks.onLog({ level, message, timestamp: Date.now() });
        }
    }
}
