from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
import socket
import sys
import threading
import time
import webbrowser

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT_CANDIDATES = [8000, 5173, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009]

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        print("[%s] %s" % (self.log_date_time_string(), format % args))


def can_bind(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((HOST, port))
            return True
        except OSError:
            return False


def main():
    os.chdir(ROOT)
    port = next((p for p in PORT_CANDIDATES if can_bind(p)), None)
    if port is None:
        print("没有找到可用端口。请关闭占用 8000/5173 等端口的程序后重试。")
        input("按回车退出...")
        return 1

    url = f"http://{HOST}:{port}/index.html"
    server = ThreadingHTTPServer((HOST, port), QuietHandler)

    print("============================================")
    print("璀璨宝石之大学模拟器 本地服务器")
    print("============================================")
    print(f"项目目录：{ROOT}")
    print(f"访问地址：{url}")
    print("浏览器即将自动打开。")
    print("请不要关闭这个黑色窗口；关闭后网页会停止服务。")
    print("如果浏览器没弹出，请手动复制上面的访问地址。")
    print("按 Ctrl+C 可停止服务器。")
    print("============================================")

    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止。")
    finally:
        server.server_close()
    return 0

if __name__ == "__main__":
    sys.exit(main())
