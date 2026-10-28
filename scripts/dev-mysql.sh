#!/usr/bin/env bash
# Starts a local MySQL 8 server in Docker for testing the database features.
# It listens on 127.0.0.1 only, so other machines cannot reach it.
#
# Usage: scripts/dev-mysql.sh [start|stop|reset|shell]
#   start  start the server (and load scripts/dev-mysql/seed.sql the first time)
#   stop   stop and remove the container (data is lost)
#   reset  stop, then start with fresh sample data
#   shell  open the mysql command line inside the container
#
# Connection for Kestrel: host 127.0.0.1, port 13306, user root,
# password below (test value only), database kestrel_demo.
set -euo pipefail

NAME=kestrel-dev-mysql
IMAGE=${KESTREL_MYSQL_IMAGE:-mysql:8.0.28}
PORT=${KESTREL_MYSQL_PORT:-13306}
PASSWORD=kestrel-dev-pw
DIR="$(cd "$(dirname "$0")" && pwd)/dev-mysql"

start() {
  if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "already running on 127.0.0.1:$PORT"
    return
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -p "127.0.0.1:$PORT:3306" \
    -e MYSQL_ROOT_PASSWORD="$PASSWORD" \
    -v "$DIR:/docker-entrypoint-initdb.d:ro" \
    "$IMAGE" --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci >/dev/null
  echo -n "waiting for MySQL"
  # The amd64 image runs emulated on Apple Silicon, so the first start can take minutes.
  for _ in $(seq 1 300); do
    if docker exec "$NAME" mysql -uroot -p"$PASSWORD" -e 'SELECT 1 FROM kestrel_demo.titles LIMIT 1' >/dev/null 2>&1; then
      echo " ready on 127.0.0.1:$PORT"
      return
    fi
    echo -n "."
    sleep 1
  done
  echo " timed out (see: docker logs $NAME)"
  exit 1
}

case "${1:-start}" in
  start) start ;;
  stop) docker rm -f "$NAME" >/dev/null && echo stopped ;;
  reset) docker rm -f "$NAME" >/dev/null 2>&1 || true; start ;;
  shell) docker exec -it "$NAME" mysql -uroot -p"$PASSWORD" kestrel_demo ;;
  *) echo "usage: $0 [start|stop|reset|shell]"; exit 1 ;;
esac
