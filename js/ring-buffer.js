/**
 * 环形缓冲区 — 固定容量、O(1) 写入
 * 替代无限增长的 Array，防止内存膨胀
 *
 * 用法:
 *   const buf = new RingBuffer(2000);
 *   buf.push({ time: Date.now(), value: 23.5 });
 *   buf.toArray();           // 按时间顺序返回
 *   buf.filterByTime(t1, t2); // 按时间范围过滤
 *   buf.stats();             // { count, max, min, avg }
 */
(function () {
    'use strict';

    class RingBuffer {
        constructor(capacity = 2000) {
            this._buf = new Array(capacity);
            this._capacity = capacity;
            this._head = 0;  // 下一个写入位置
            this._size = 0;  // 当前元素数
        }

        get capacity() { return this._capacity; }
        get size() { return this._size; }
        get length() { return this._size; }

        /** 添加一个元素 */
        push(item) {
            this._buf[this._head] = item;
            this._head = (this._head + 1) % this._capacity;
            if (this._size < this._capacity) this._size++;
        }

        /** 添加多个元素 */
        pushAll(items) {
            for (const item of items) this.push(item);
        }

        /** 返回按时间顺序排列的数组（假设 push 顺序即时间顺序） */
        toArray() {
            const result = [];
            if (this._size === 0) return result;

            let start;
            if (this._size < this._capacity) {
                start = 0;
            } else {
                start = this._head; // 最旧的元素
            }

            for (let i = 0; i < this._size; i++) {
                result.push(this._buf[(start + i) % this._capacity]);
            }
            return result;
        }

        /** 按时间范围过滤（要求 item.time 是 Date 或时间戳） */
        filterByTime(startTime, endTime) {
            const arr = this.toArray();
            const start = startTime instanceof Date ? startTime.getTime() : startTime;
            const end = endTime instanceof Date ? endTime.getTime() : endTime;
            return arr.filter(item => {
                const t = item.time instanceof Date ? item.time.getTime() : item.time;
                return t >= start && t <= end;
            });
        }

        /** 统计聚合（假设 item.value 是数值） */
        stats() {
            if (this._size === 0) return { count: 0, max: NaN, min: NaN, avg: NaN };
            const arr = this.toArray();
            const values = arr.map(d => d.value).filter(v => typeof v === 'number' && !isNaN(v));
            if (values.length === 0) return { count: 0, max: NaN, min: NaN, avg: NaN };
            return {
                count: values.length,
                max: Math.max(...values),
                min: Math.min(...values),
                avg: values.reduce((a, b) => a + b, 0) / values.length,
            };
        }

        /** 获取最新 N 个元素 */
        last(n) {
            const arr = this.toArray();
            return arr.slice(-Math.min(n, arr.length));
        }

        /** 获取最新一个元素 */
        latest() {
            if (this._size === 0) return null;
            const idx = (this._head - 1 + this._capacity) % this._capacity;
            return this._buf[idx];
        }

        /** 清空 */
        clear() {
            this._buf = new Array(this._capacity);
            this._head = 0;
            this._size = 0;
        }

        /** 数组兼容: forEach */
        forEach(fn) { this.toArray().forEach(fn); }

        /** 数组兼容: filter */
        filter(fn) { return this.toArray().filter(fn); }

        /** 数组兼容: map */
        map(fn) { return this.toArray().map(fn); }

        /** 数组兼容: slice */
        slice(a, b) { return this.toArray().slice(a, b); }

        /** 移除最旧的 N 个元素（兼容 Array.shift） */
        shift() {
            if (this._size === 0) return undefined;
            const start = this._size < this._capacity ? 0 : this._head;
            const val = this._buf[start];
            if (this._size <= this._capacity) {
                // 覆盖最旧位置
                this._buf[start] = undefined;
            }
            this._size--;
            if (this._size >= this._capacity) {
                this._head = (this._head + 1) % this._capacity;
            }
            return val;
        }

        /** 数组兼容: splice (只支持从头删除) */
        splice(start, deleteCount) {
            const arr = this.toArray();
            const removed = arr.splice(start, deleteCount);
            // 用剩余元素重建
            this.clear();
            this.pushAll(arr);
            return removed;
        }

        /** 调整容量（会保留尽可能多的最新数据） */
        resize(newCapacity) {
            const data = this.last(Math.min(this._size, newCapacity));
            this._buf = new Array(newCapacity);
            this._capacity = newCapacity;
            this._head = 0;
            this._size = 0;
            this.pushAll(data);
        }
    }

    window.RingBuffer = RingBuffer;
})();