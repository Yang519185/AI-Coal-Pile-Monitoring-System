/**
 * AI 分析模块
 * 调用火山引擎豆包大模型 API 分析温度数据趋势
 */

const AiAnalysis = {
    /**
     * 分析温度数据
     * @param {Object} settings - { aiEndpoint, aiApiKey, alarmHigh, alarmLow }
     * @param {Array} records - 温度记录数组
     * @param {Object} stats - 统计信息 { max, min, avg, alarmCount, ... }
     * @returns {Promise<Object>} AI 分析结果
     */
    async analyze(settings, records, stats) {
        if (!settings.aiEndpoint || !settings.aiApiKey) {
            throw new Error('请先在系统设置中配置 AI API 端点和密钥');
        }

        const prompt = this.buildPrompt(records, stats, settings);

        // 最多重试 2 次，超时 60 秒（低于 Cloudflare 120s 限制，避免 524）
        const maxRetries = 2;
        const timeoutMs = 60000;
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                // 重试前等待递增时间
                const waitMs = attempt * 3000;
                console.log(`AI 分析重试第 ${attempt} 次，等待 ${waitMs / 1000}s...`);
                await new Promise(r => setTimeout(r, waitMs));
            }

            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);

                const response = await fetch(settings.aiEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${settings.aiApiKey}`
                    },
                    body: JSON.stringify({
                        model: 'doubao-pro-32k',
                        messages: [
                            {
                                role: 'system',
                                content: '你是一个专业的工业温度监测分析师。请根据提供的温度数据，给出专业的分析和建议。使用中文回答，结构清晰，重点突出。'
                            },
                            {
                                role: 'user',
                                content: prompt
                            }
                        ],
                        temperature: 0.7,
                        max_tokens: 2000
                    }),
                    signal: controller.signal
                });

                clearTimeout(timer);

                if (!response.ok) {
                    const errorText = await response.text();
                    // 5xx 错误可重试，4xx 直接抛
                    if (response.status >= 500 && attempt < maxRetries) {
                        console.warn(`AI API ${response.status}，将重试...`);
                        lastError = new Error(`API 服务器错误 (${response.status})，正在重试...`);
                        continue;
                    }
                    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
                }

                const data = await response.json();

                if (!data.choices || data.choices.length === 0) {
                    throw new Error('AI 返回数据格式异常');
                }

                return this.parseResponse(data.choices[0].message.content);

            } catch (error) {
                clearTimeout(timer);
                if (error.name === 'AbortError') {
                    lastError = new Error(`AI 请求超时 (${timeoutMs / 1000}s)，服务器响应过慢，请稍后重试`);
                    if (attempt < maxRetries) continue;
                }
                lastError = error;
                console.error('AI 分析失败:', error);
            }
        }

        throw lastError || new Error('AI 分析失败，已重试 2 次仍无法完成');
    },

    /**
     * 构建分析提示词
     */
    buildPrompt(records, stats, settings) {
        // 提取最近的数据点（最多100个）
        const recentRecords = records.slice(-100);

        // 按传感器分组
        const bySensor = {};
        recentRecords.forEach(r => {
            if (!bySensor[r.sensor]) bySensor[r.sensor] = [];
            bySensor[r.sensor].push({
                time: new Date(r.timestamp).toLocaleString('zh-CN'),
                temp: r.temperature
            });
        });

        const dataSummary = Object.entries(bySensor).map(([sensor, points]) => {
            return `${sensor}: ${points.length} 个数据点，温度范围 ${Math.min(...points.map(p => p.temp)).toFixed(1)}°C ~ ${Math.max(...points.map(p => p.temp)).toFixed(1)}°C`;
        }).join('\n');

        return `请分析以下温度监测数据：

## 基本信息
- 总数据点: ${records.length} 个
- 时间跨度: ${new Date(records[0].timestamp).toLocaleString('zh-CN')} ~ ${new Date(records[records.length - 1].timestamp).toLocaleString('zh-CN')}
- 高温报警阈值: ${settings.alarmHigh}°C
- 低温报警阈值: ${settings.alarmLow}°C

## 统计摘要
- 最高温度: ${stats.max.toFixed(1)}°C
- 最低温度: ${stats.min.toFixed(1)}°C
- 平均温度: ${stats.avg.toFixed(1)}°C
- 报警次数: ${stats.alarmCount} 次

## 最近数据（按传感器）
${dataSummary}

## 请提供以下分析

### 1. 整体趋势分析
分析温度变化的整体趋势，是否存在明显的上升或下降模式。

### 2. 异常检测
识别数据中的异常点或异常模式，可能的原因分析。

### 3. 报警分析
报警发生的频率和分布，是否存在系统性问题。

### 4. 风险预警
基于当前趋势，预测未来可能出现的问题。

### 5. 维护建议
给出具体的设备维护和优化建议。

请用简洁专业的语言回答，重点突出关键发现和建议。`;
    },

    /**
     * 解析 AI 响应
     */
    parseResponse(content) {
        // 简单的 Markdown 解析，提取主要章节
        const sections = [];
        const lines = content.split('\n');

        let currentSection = null;
        let currentContent = [];

        lines.forEach(line => {
            const headerMatch = line.match(/^###\s+(.+)$/);
            if (headerMatch) {
                if (currentSection) {
                    sections.push({
                        title: currentSection,
                        content: currentContent.join('\n').trim()
                    });
                }
                currentSection = headerMatch[1];
                currentContent = [];
            } else if (currentSection) {
                currentContent.push(line);
            }
        });

        if (currentSection) {
            sections.push({
                title: currentSection,
                content: currentContent.join('\n').trim()
            });
        }

        return {
            raw: content,
            sections: sections.length > 0 ? sections : [{ title: '分析结果', content: content }]
        };
    }
};

window.AiAnalysis = AiAnalysis;
