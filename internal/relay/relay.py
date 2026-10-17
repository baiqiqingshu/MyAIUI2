# -*- coding: utf-8 -*-
"""MyAIUI2 本地 HTTP 中转（仅 Python 标准库，由 Go 侧拉起）。

内网环境下 Go 进程直连 http/https 会被系统代理拦截失败；Go 侧把所有受限外发
请求改发到 http://127.0.0.1:<port>/relay，由本进程用 http.client 直连目标
（http.client 不读环境代理、不跟随重定向）；https 关闭证书校验（内网自签
证书/AI 中转站场景）。

协议：
  GET  /health                -> 200 "ok"
  POST /relay                 -> 转发到 X-Relay-URL 并把上游响应流式回写
    X-Relay-Method   目标请求方法（默认 POST）
    X-Relay-URL      目标绝对 URL（必填，仅 http/https）
    X-Relay-Timeout  单次 socket 操作超时秒数（默认 600，上限 3600）

就绪后向 stdout 打印一行 "RELAY_READY 127.0.0.1:<port>"（Go 侧以此探测启动），
启动失败打印 "RELAY_ERROR <msg>" 并以退出码 1 退出。
"""

import argparse
import http.client
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

READ_CHUNK = 32768
# 入站请求体上限（Go 侧限制 16MB，这里留一倍余量防御异常流量）。
MAX_INBOUND_BODY = 32 * 1024 * 1024
# 上游响应体防御上限（Go 侧另有 64MB 事件上限，这里只是兜底防内存/磁盘打爆）。
MAX_RESPONSE_BYTES = 128 * 1024 * 1024
DEFAULT_TIMEOUT = 600.0
MAX_TIMEOUT = 3600.0

# 入站头里不透传给上游的逐跳/控制头（X-Relay-* 只对本服务有意义）。
DROP_REQUEST_EXACT = frozenset((
    "host", "content-length", "connection", "keep-alive",
    "transfer-encoding", "upgrade", "te", "trailer", "expect",
))
DROP_REQUEST_PREFIX = ("proxy-", "x-relay-")

# 上游响应里不回写的逐跳头；content-length 必须丢弃——回写统一走 chunked。
DROP_RESPONSE_EXACT = frozenset((
    "connection", "keep-alive", "transfer-encoding", "upgrade",
    "content-length",
))
DROP_RESPONSE_PREFIX = ("proxy-",)


def _short(exc):
    """异常转单行短文本，避免写进日志/响应的多行堆栈。"""
    text = str(exc) or exc.__class__.__name__
    return " ".join(text.split())[:300]


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MyAIUI2Relay"
    sys_version = ""

    def log_message(self, fmt, *args):
        # 默认实现会把每行请求（含路径/查询）打到 stderr；静默以免泄露 URL。
        pass

    # ---------------------------------------------------------------- 基础

    def _send_plain(self, status, text):
        body = text.encode("utf-8", "replace")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def do_GET(self):
        try:
            if self.path == "/health":
                body = b"ok"
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self._send_plain(404, "not found")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._send_plain(500, _short(exc))

    def do_POST(self):
        # responded=False 表示还没有向上游响应写任何字节，此时出错还能回 502；
        # 一旦开始回写上游响应（含 chunked 流）就只能直接断开。
        responded = False
        try:
            if self.path != "/relay":
                self._send_plain(404, "not found")
                return
            responded = self._relay()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端断连，静默收尾
        except Exception as exc:
            if not responded:
                self._send_plain(502, "upstream error: %s" % _short(exc))
        finally:
            self.close_connection = True

    # ---------------------------------------------------------------- 中转

    def _relay(self):
        """返回 True 表示已向客户端写过响应（成功或 4xx），异常时由调用方兜底。"""
        target = (self.headers.get("X-Relay-URL") or "").strip()
        method = (self.headers.get("X-Relay-Method") or "POST").strip().upper()
        if not method:
            method = "POST"
        raw_timeout = (self.headers.get("X-Relay-Timeout") or "").strip()
        try:
            timeout_s = float(raw_timeout) if raw_timeout else DEFAULT_TIMEOUT
        except ValueError:
            timeout_s = DEFAULT_TIMEOUT
        timeout_s = min(max(timeout_s, 1.0), MAX_TIMEOUT)

        parsed = None
        try:
            parsed = urlparse(target)
            _ = parsed.port  # 非法端口在取值时才抛 ValueError
        except Exception:
            parsed = None
        if (parsed is None or parsed.scheme not in ("http", "https")
                or not parsed.hostname):
            self._send_plain(400, "missing or invalid X-Relay-URL")
            return True

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_INBOUND_BODY:
            self._send_plain(400, "invalid Content-Length")
            return True

        # 读请求体与写响应都受同一 socket 超时约束。
        self.connection.settimeout(timeout_s)
        body = self.rfile.read(length) if length > 0 else None

        # 入站头剔除逐跳/控制头后原样转发；Content-Length 按实际体重设。
        headers = {}
        for name, value in self.headers.items():
            lname = name.strip().lower()
            if lname in DROP_REQUEST_EXACT or lname.startswith(DROP_REQUEST_PREFIX):
                continue
            headers[name] = value
        if body is not None:
            headers["Content-Length"] = str(len(body))

        # http.client 直连目标：不走任何代理，也不会跟随重定向。
        if parsed.scheme == "https":
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            conn = http.client.HTTPSConnection(
                parsed.hostname, port=parsed.port,
                timeout=timeout_s, context=ctx)
        else:
            conn = http.client.HTTPConnection(
                parsed.hostname, port=parsed.port, timeout=timeout_s)

        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        try:
            self.send_response(resp.status)
            for name, value in resp.getheaders():
                lname = name.lower()
                if (lname in DROP_RESPONSE_EXACT
                        or lname.startswith(DROP_RESPONSE_PREFIX)):
                    continue
                self.send_header(name, value)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            remaining = MAX_RESPONSE_BYTES
            while True:
                chunk = resp.read(READ_CHUNK)
                if not chunk:
                    break
                remaining -= len(chunk)
                if remaining <= 0:
                    break
                self.wfile.write(("%x\r\n" % len(chunk)).encode("ascii"))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
        finally:
            conn.close()
        return True


def main():
    parser = argparse.ArgumentParser(description="MyAIUI2 local relay")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer((args.bind, args.port), RelayHandler)
        server.daemon_threads = True
    except Exception as exc:
        print("RELAY_ERROR %s" % _short(exc), flush=True)
        sys.exit(1)

    host, port = server.server_address[:2]
    print("RELAY_READY %s:%d" % (host, port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print("RELAY_ERROR %s" % _short(exc), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
