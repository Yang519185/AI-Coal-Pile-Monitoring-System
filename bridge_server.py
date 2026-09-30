#!/usr/bin/env python3
"""
WebSocket ↔ TCP 桥接服务器
用于浏览器"网口直连"模式：浏览器通过 WebSocket 连接到此桥接服务器，
桥接服务器再通过 TCP 连接到嵌入式设备。

用法:
    python bridge_server.py --ws-port 9000 --tcp-host 192.168.1.100 --tcp-port 8080

依赖:
    pip install websockets
"""

import asyncio
import argparse
import signal
import sys
import json
import struct
import time
from datetime import datetime

try:
    import websockets
except ImportError:
    print("错误: 需要安装 websockets 库")
    print("运行: pip install websockets")
    sys.exit(1)

# ===================== 全局状态 =====================
tcp_writer = None
tcp_reader = None
ws_client = None
running = True
stats = {
    "ws_to_tcp": 0,
    "tcp_to_ws": 0,
    "started": datetime.now().isoformat(),
}

# ===================== TCP 客户端 =====================
async def tcp_connect(host, port):
    """连接到 TCP 设备"""
    global tcp_reader, tcp_writer
    try:
        tcp_reader, tcp_writer = await asyncio.open_connection(host, port)
        print(f"[TCP] ✓ 已连接到 {host}:{port}")
        return True
    except Exception as e:
        print(f"[TCP] ✗ 连接失败 {host}:{port}: {e}")
        return False


async def tcp_receive_loop(websocket):
    """TCP → WebSocket 数据转发"""
    global tcp_reader, running
    buf = b""

    while running and tcp_reader:
        try:
            data = await asyncio.wait_for(tcp_reader.read(4096), timeout=1.0)
            if not data:
                print("[TCP] 设备断开连接")
                break

            buf += data
            stats["tcp_to_ws"] += len(data)

            # 尝试按行解析
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if line:
                    text = line.decode("utf-8", errors="replace")
                    print(f"[TCP→WS] {text[:100]}{'...' if len(text) > 100 else ''}")

                    # 尝试解析 JSON
                    try:
                        parsed = json.loads(text)
                        await websocket.send(json.dumps(parsed))
                    except json.JSONDecodeError:
                        # 非 JSON，包装后发送
                        msg = json.dumps({
                            "raw": text,
                            "timestamp": time.time(),
                            "source": "tcp_device"
                        })
                        await websocket.send(msg)

        except asyncio.TimeoutError:
            continue
        except Exception as e:
            print(f"[TCP] 读取错误: {e}")
            break

    print("[TCP] 接收循环结束")


# ===================== WebSocket 处理 =====================
async def handle_websocket(websocket, path):
    """处理浏览器 WebSocket 连接"""
    global ws_client, tcp_reader, tcp_writer, running

    ws_client = websocket
    client_addr = websocket.remote_address
    print(f"\n[WS] 浏览器连接: {client_addr}")

    # 获取 TCP 配置（从启动参数）
    tcp_host = handle_websocket.tcp_host
    tcp_port = handle_websocket.tcp_port

    # 连接 TCP 设备
    connected = await tcp_connect(tcp_host, tcp_port)
    if not connected:
        await websocket.send(json.dumps({
            "type": "error",
            "message": f"无法连接到设备 {tcp_host}:{tcp_port}"
        }))
        return

    await websocket.send(json.dumps({
        "type": "connected",
        "message": f"已桥接到 {tcp_host}:{tcp_port}",
        "timestamp": time.time()
    }))

    # 启动 TCP→WS 转发
    tcp_task = asyncio.create_task(tcp_receive_loop(websocket))

    # WS→TCP 转发
    try:
        async for message in websocket:
            if not running:
                break

            text = message if isinstance(message, str) else message.decode("utf-8", errors="replace")
            print(f"[WS→TCP] {text[:100]}{'...' if len(text) > 100 else ''}")

            if tcp_writer:
                try:
                    tcp_writer.write((text + "\n").encode("utf-8"))
                    await tcp_writer.drain()
                    stats["ws_to_tcp"] += len(text)
                except Exception as e:
                    print(f"[WS→TCP] 写入错误: {e}")
                    break

    except websockets.exceptions.ConnectionClosed:
        print("[WS] 浏览器断开连接")
    finally:
        running = False
        tcp_task.cancel()

        if tcp_writer:
            try:
                tcp_writer.close()
                await tcp_writer.wait_closed()
            except Exception:
                pass

        print(f"[统计] WS→TCP: {stats['ws_to_tcp']} bytes, TCP→WS: {stats['tcp_to_ws']} bytes")
        print("[桥接] 会话结束\n")


# ===================== 命令行参数 =====================
def parse_args():
    parser = argparse.ArgumentParser(
        description="WebSocket ↔ TCP 桥接服务器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 桥接本地 9000 端口 (WebSocket) 到 192.168.1.100:8080 (TCP)
  python bridge_server.py --ws-port 9000 --tcp-host 192.168.1.100 --tcp-port 8080

  # 监听所有网络接口
  python bridge_server.py --ws-port 9000 --ws-host 0.0.0.0 --tcp-host 192.168.1.100 --tcp-port 8080

  # 桥接到 EMQX (MQTT 协议通过 TCP)
  python bridge_server.py --ws-port 9000 --tcp-host broker.emqx.io --tcp-port 1883
        """
    )
    parser.add_argument("--ws-host", default="localhost", help="WebSocket 监听地址 (默认: localhost)")
    parser.add_argument("--ws-port", type=int, default=9000, help="WebSocket 监听端口 (默认: 9000)")
    parser.add_argument("--tcp-host", default="192.168.1.100", help="TCP 设备地址 (默认: 192.168.1.100)")
    parser.add_argument("--tcp-port", type=int, default=8080, help="TCP 设备端口 (默认: 8080)")
    return parser.parse_args()


# ===================== 主函数 =====================
async def main():
    global running

    args = parse_args()

    # 将 TCP 配置附加到处理函数
    handle_websocket.tcp_host = args.tcp_host
    handle_websocket.tcp_port = args.tcp_port

    print("=" * 56)
    print("  WebSocket ↔ TCP 桥接服务器")
    print("=" * 56)
    print(f"  WebSocket: ws://{args.ws_host}:{args.ws_port}")
    print(f"  TCP 设备:  {args.tcp_host}:{args.tcp_port}")
    print(f"  浏览器连接 ws://{args.ws_host}:{args.ws_port} 即可")
    print("-" * 56)
    print("  按 Ctrl+C 停止服务器")
    print("=" * 56)

    # 设置信号处理
    loop = asyncio.get_event_loop()

    def shutdown():
        global running
        print("\n正在关闭...")
        running = False

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, shutdown)
        except NotImplementedError:
            # Windows 不支持 add_signal_handler
            pass

    try:
        async with websockets.serve(handle_websocket, args.ws_host, args.ws_port):
            await asyncio.Future()  # 永久运行
    except asyncio.CancelledError:
        pass
    except KeyboardInterrupt:
        pass
    finally:
        print("服务器已停止")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n服务器已停止")
