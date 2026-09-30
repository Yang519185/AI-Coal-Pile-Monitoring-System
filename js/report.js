/**
 * 日报 / 周报 自动生成模块
 * 纯前端生成自包含 HTML 报表（内联 CSS + 内联 SVG 折线），
 * 新窗口打开后可「打印 / 存为 PDF」。
 *
 * 暴露全局 generateReport(type, records, settings)
 *   type     : 'daily' | 'weekly'
 *   records  : [{timestamp:Date, topic, sensor, temperature}]
 *   settings : {alarmHigh, alarmLow}
 */
(function () {
    'use strict';

    const COLOR_TABLE = ['#4285f4', '#34a853', '#fbbc04', '#ea4335', '#9c27b0', '#00bcd4', '#ff9800', '#795548'];

    /** 从全局获取动态传感器配置 */
    function _cfg() {
        return (window._getSensorConfig ? window._getSensorConfig() : null)
            || { sensors: [{key:'topic1',name:'传感器 #1'},{key:'topic2',name:'传感器 #2'},{key:'topic3',name:'传感器 #3'}] };
    }
    function _keys() { return _cfg().sensors.map(s => s.key); }
    function _name(k) { const s = _cfg().sensors.find(s => s.key === k); return s ? s.name : k; }
    function _color(i) { return COLOR_TABLE[i % COLOR_TABLE.length]; }
    function _mapColors() {
        const m = {};
        _cfg().sensors.forEach((s, i) => { m[s.key] = COLOR_TABLE[i % COLOR_TABLE.length]; });
        return m;
    }

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function fmtDateTime(d) { return d.toLocaleString('zh-CN', { hour12: false }); }
    function fmtDate(d) { return d.toLocaleDateString('zh-CN'); }
    function fmtTime(d) { return d.toLocaleTimeString('zh-CN', { hour12: false }); }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    /** 计算统计范围 */
    function computeRange(type) {
        const end = new Date();
        let start;
        if (type === 'daily') {
            start = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0, 0);
        } else {
            const day = end.getDay();
            const diff = day === 0 ? 6 : day - 1;
            start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - diff, 0, 0, 0, 0);
        }
        return { start, end };
    }

    /** 从记录里抽取温度序列 */
    function extractSeries(records, start, end) {
        const keys = _keys();
        const inRange = records.filter(r => {
            const t = r.timestamp;
            return t && t >= start && t <= end && r.temperature !== null && !isNaN(r.temperature);
        });
        const series = {};
        keys.forEach(k => { series[k] = []; });
        inRange.forEach(r => {
            const k = r.sensor;
            if (series[k]) series[k].push({ t: r.timestamp.getTime(), v: r.temperature, ts: r.timestamp });
        });
        return { inRange, series };
    }

    /** 计算统计 */
    function computeStats(series, alarmHigh, alarmLow) {
        const keys = _keys();
        const perSensor = {};
        let allVals = [];
        keys.forEach(k => {
            const vals = series[k].map(p => p.v);
            allVals = allVals.concat(vals);
            perSensor[k] = {
                count: vals.length,
                max: vals.length ? Math.max(...vals) : null,
                min: vals.length ? Math.min(...vals) : null,
                avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
            };
        });
        let alarmCount = 0, maxV = null, minV = null, peakTs = null;
        if (allVals.length) {
            maxV = Math.max(...allVals);
            minV = Math.min(...allVals);
            alarmCount = allVals.filter(v => v >= alarmHigh || v <= alarmLow).length;
            for (const k of keys) {
                for (const p of series[k]) {
                    if (p.v === maxV) { peakTs = p.ts; break; }
                }
                if (peakTs) break;
            }
        }
        return { perSensor, total: allVals.length, max: maxV, min: minV, avg: allVals.length ? (allVals.reduce((a, b) => a + b, 0) / allVals.length) : null, alarmCount, peakTs };
    }

    /** 生成 SVG 折线图 */
    function buildChartSvg(series, start, end, alarmHigh, alarmLow, stats, type) {
        const keys = _keys();
        const colors = _mapColors();
        const W = 920, H = 340;
        const padL = 56, padR = 20, padT = 22, padB = 42;
        const iw = W - padL - padR, ih = H - padT - padB;
        const t0 = start.getTime(), t1 = end.getTime();
        const tSpan = Math.max(t1 - t0, 1);

        let yMin = stats.min !== null ? stats.min : 0;
        let yMax = stats.max !== null ? stats.max : 70;
        yMin = Math.min(yMin, alarmLow); yMax = Math.max(yMax, alarmHigh);
        yMin = clamp(yMin - 3, -20, 100);
        yMax = clamp(yMax + 3, -20, 120);
        if (yMax - yMin < 10) { yMax = yMin + 10; }

        const X = (t) => padL + ((t - t0) / tSpan) * iw;
        const Y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * ih;

        let svg = '';
        const yTicks = 5;
        for (let i = 0; i <= yTicks; i++) {
            const v = yMin + (yMax - yMin) * i / yTicks;
            const y = Y(v);
            svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e8ebf0" stroke-width="1"/>`;
            svg += `<text x="${padL - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="#8a93a3">${v.toFixed(0)}°C</text>`;
        }
        for (let i = 0; i <= 4; i++) {
            const t = t0 + (t1 - t0) * i / 4;
            const x = X(t);
            const d = new Date(t);
            const label = type === 'daily' ? fmtTime(d) : (fmtDate(d).slice(5) + ' ' + fmtTime(d));
            svg += `<text x="${x}" y="${H - 14}" text-anchor="middle" font-size="11" fill="#8a93a3">${esc(label)}</text>`;
        }

        const drawThreshold = (v, color, label) => {
            if (v < yMin || v > yMax) return '';
            const y = Y(v);
            return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${color}" stroke-width="1.2" stroke-dasharray="6,4"/>`
                + `<text x="${W - padR - 4}" y="${y - 6}" text-anchor="end" font-size="10" fill="${color}">${label} ${v}°C</text>`;
        };
        svg += drawThreshold(alarmHigh, '#ea4335', '高温阈值');
        svg += drawThreshold(alarmLow, '#4285f4', '低温阈值');

        keys.forEach(k => {
            const pts = series[k];
            if (pts.length < 2) return;
            const MAX = 400;
            const step = Math.max(1, Math.ceil(pts.length / MAX));
            let d = '';
            for (let i = 0; i < pts.length; i += step) {
                const p = pts[i];
                const x = X(p.t).toFixed(1), y = Y(p.v).toFixed(1);
                d += (i === 0 ? 'M' : 'L') + x + ',' + y;
            }
            svg += `<path d="${d}" fill="none" stroke="${colors[k] || '#999'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        });

        svg += `<rect x="${padL}" y="${padT}" width="${iw}" height="${ih}" fill="none" stroke="#dfe3ea" stroke-width="1"/>`;
        return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;">${svg}</svg>`;
    }

    /** 生成异常事件表 */
    function buildEventsTable(series, n) {
        const keys = _keys();
        const events = [];
        keys.forEach(k => { series[k].forEach(p => events.push({ sensor: k, v: p.v, ts: p.ts })); });
        events.sort((a, b) => b.v - a.v);
        const top = events.slice(0, n);
        if (top.length === 0) return '<p class="muted">该时间段内暂无数据。</p>';
        return '<table class="tbl"><thead><tr><th>#</th><th>时间</th><th>测点</th><th>温度</th></tr></thead><tbody>'
            + top.map((e, i) => `<tr><td>${i + 1}</td><td>${esc(fmtDateTime(e.ts))}</td><td>${esc(_name(e.sensor))}</td><td>${e.v.toFixed(1)} °C</td></tr>`).join('')
            + '</tbody></table>';
    }

    function statCard(label, value, sub, color) {
        return `<div class="stat"><div class="stat-label">${esc(label)}</div>`
            + `<div class="stat-value" style="color:${color || '#1a2233'}">${esc(value)}</div>`
            + (sub ? `<div class="stat-sub">${esc(sub)}</div>` : '') + '</div>';
    }

    function generateReport(type, records, settings) {
        settings = settings || {};
        const alarmHigh = settings.alarmHigh !== undefined ? settings.alarmHigh : 50;
        const alarmLow = settings.alarmLow !== undefined ? settings.alarmLow : 0;
        const keys = _keys();
        const colors = _mapColors();

        const { start, end } = computeRange(type);
        const { inRange, series } = extractSeries(records, start, end);
        const stats = computeStats(series, alarmHigh, alarmLow);

        const typeLabel = type === 'daily' ? '日报' : '周报';
        const rangeLabel = `${fmtDate(start)} ~ ${fmtDate(end)}`;

        const sensorRows = keys.map(k => {
            const s = stats.perSensor[k];
            const v = (x) => x === null ? '--' : x.toFixed(1) + ' °C';
            return `<tr><td><span class="dot" style="background:${colors[k] || '#999'}"></span>${esc(_name(k))}</td>`
                + `<td>${s.count}</td><td>${v(s.max)}</td><td>${v(s.min)}</td><td>${v(s.avg)}</td></tr>`;
        }).join('');

        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>温度监测${typeLabel} - ${esc(rangeLabel)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif; background:#f0f2f5; color:#202124; line-height:1.6; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 24px 48px; }
  .no-print { text-align:right; margin-bottom:16px; }
  .no-print button { padding:10px 22px; background:#1a73e8; color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; }
  .no-print button:hover { background:#1557b0; }
  .report { background:#fff; border-radius:14px; box-shadow:0 2px 8px rgba(0,0,0,.06); padding:36px 40px; }
  header.rep-head { border-bottom:2px solid #1a73e8; padding-bottom:20px; margin-bottom:24px; display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:12px; }
  .rep-title { font-size:26px; font-weight:700; color:#1a1f36; }
  .rep-meta { font-size:13px; color:#5f6368; margin-top:6px; }
  .rep-range { font-size:14px; color:#1a73e8; font-weight:600; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; margin-bottom:24px; }
  .stat { background:#f7f9fc; border:1px solid #eef1f6; border-radius:10px; padding:14px 16px; text-align:center; }
  .stat-label { font-size:11px; color:#8a93a3; text-transform:uppercase; font-weight:600; letter-spacing:.5px; }
  .stat-value { font-size:22px; font-weight:700; margin-top:4px; }
  .stat-sub { font-size:11px; color:#8a93a3; }
  h2.sec { font-size:16px; font-weight:600; margin:26px 0 14px; color:#1a1f36; border-left:4px solid #1a73e8; padding-left:10px; }
  .chart { border:1px solid #eef1f6; border-radius:10px; padding:12px; background:#fff; }
  table.tbl { width:100%; border-collapse:collapse; font-size:13px; }
  table.tbl th { background:#f7f9fc; text-align:left; padding:9px 12px; font-weight:600; color:#5f6368; font-size:12px; border-bottom:2px solid #e0e0e0; }
  table.tbl td { padding:9px 12px; border-bottom:1px solid #f0f0f0; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; }
  .muted { color:#8a93a3; }
  footer { margin-top:28px; padding-top:16px; border-top:1px solid #eef1f6; font-size:12px; color:#9aa0a6; text-align:center; }
  @media print { .no-print { display:none; } body { background:#fff; } .report { box-shadow:none; padding:0; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="no-print"><button onclick="window.print()">打印 / 存为 PDF</button></div>
  <div class="report">
    <header class="rep-head">
      <div>
        <div class="rep-title">温度监测${typeLabel}</div>
        <div class="rep-meta">IoT 温度监控平台 · 生成于 ${esc(fmtDateTime(new Date()))}</div>
      </div>
      <div class="rep-range">${esc(rangeLabel)}</div>
    </header>
    <div class="stats">
      ${statCard('有效数据点', stats.total, inRange.length + ' 条原始记录')}
      ${statCard('最高温度', stats.max === null ? '--' : stats.max.toFixed(1) + ' °C', stats.peakTs ? '峰值 ' + fmtTime(stats.peakTs) : '', '#ea4335')}
      ${statCard('最低温度', stats.min === null ? '--' : stats.min.toFixed(1) + ' °C', '', '#4285f4')}
      ${statCard('平均温度', stats.avg === null ? '--' : stats.avg.toFixed(1) + ' °C')}
      ${statCard('报警次数', stats.alarmCount, '阈值 ' + alarmHigh + '°C / ' + alarmLow + '°C', '#ea4335')}
    </div>
    <h2 class="sec">温度变化趋势</h2>
    <div class="chart">${buildChartSvg(series, start, end, alarmHigh, alarmLow, stats, type)}</div>
    <h2 class="sec">各测点统计</h2>
    <table class="tbl"><thead><tr><th>测点</th><th>数据点数</th><th>最高</th><th>最低</th><th>平均</th></tr></thead>
    <tbody>${sensorRows}</tbody></table>
    <h2 class="sec">高温记录 Top 8</h2>
    ${buildEventsTable(series, 8)}
    <footer>本报表由系统自动生成，数据来源于实时温度监测平台。</footer>
  </div>
</div>
</body>
</html>`;

        const blob = new Blob(['﻿' + html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const win = window.open(url, '_blank');
        if (!win) { alert('浏览器拦截了弹窗，请允许本站弹窗后重试。'); }
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    window.generateReport = generateReport;
})();