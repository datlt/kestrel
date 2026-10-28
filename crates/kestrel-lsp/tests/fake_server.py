#!/usr/bin/env python3
"""A tiny fake language server for the kestrel-lsp tests.

Behavior:
- `initialize`: replies with empty capabilities.
- `shutdown`: replies with null (unless FAKE_IGNORE_SHUTDOWN=1).
- `exit`: exits with code 0 (unless FAKE_IGNORE_SHUTDOWN=1).
- `test/crash`: exits with code 3.
- any other request: replies with the params as the result (echo).
- any notification: ignored.

Environment variables:
- FAKE_STDERR_LINES=N: write N lines to stderr at start.
- FAKE_SPAWN_CHILD=1: start `sleep 60` as a child and print its pid to stderr.
- FAKE_IGNORE_SHUTDOWN=1: never exit on shutdown/exit.
"""
import json
import os
import subprocess
import sys
import time

ignore_shutdown = os.environ.get("FAKE_IGNORE_SHUTDOWN") == "1"

for i in range(int(os.environ.get("FAKE_STDERR_LINES", "0"))):
    sys.stderr.write("stderr line %d\n" % i)
sys.stderr.flush()

if os.environ.get("FAKE_SPAWN_CHILD") == "1":
    child = subprocess.Popen(["sleep", "60"])
    sys.stderr.write("child pid %d\n" % child.pid)
    sys.stderr.flush()

inp = sys.stdin.buffer
out = sys.stdout.buffer


def read_message():
    length = None
    while True:
        line = inp.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            break
        name, _, value = line.decode("ascii").partition(":")
        if name.lower() == "content-length":
            length = int(value.strip())
    if length is None:
        return None
    body = inp.read(length)
    return json.loads(body.decode("utf-8"))


def send(msg):
    body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    out.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    out.flush()


while True:
    msg = read_message()
    if msg is None:
        break
    method = msg.get("method")
    has_id = "id" in msg
    if method == "exit":
        if ignore_shutdown:
            continue
        sys.exit(0)
    if method == "test/crash":
        sys.exit(3)
    if not has_id:
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"capabilities": {}}})
    elif method == "shutdown":
        if not ignore_shutdown:
            send({"jsonrpc": "2.0", "id": msg["id"], "result": None})
    else:
        send({"jsonrpc": "2.0", "id": msg["id"], "result": msg.get("params")})

# stdin closed: wait a little like a real server that lost its client.
time.sleep(0)
