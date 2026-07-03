#!/bin/sh
set -eu

image="${GMOS_DOCKER_IMAGE:-gmos-memory-smoke}"
container="${GMOS_DOCKER_CONTAINER:-gmos-smoke-$$}"
volume="${GMOS_DOCKER_VOLUME:-gmos-smoke-data-$$}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -t "$image" .
docker volume create "$volume" >/dev/null
docker run -d --name "$container" -v "$volume":/data -p 127.0.0.1::4787 "$image" >/dev/null
port="$(docker port "$container" 4787/tcp | sed 's/.*://')"

attempt=0
until curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

key_json="$(docker exec "$container" gmos keys create --db /data/gmos.db --label docker-smoke --scope readwrite --profiles default)"
secret="$(printf '%s' "$key_json" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).secret))")"
key_id="$(printf '%s' "$key_json" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).key.keyId))")"

curl -fsS -H "Authorization: Bearer $secret" "http://127.0.0.1:$port/runtime-info" >/dev/null
audit_json="$(docker exec "$container" gmos audit list --db /data/gmos.db --key-id "$key_id")"
printf '%s' "$audit_json" | grep -q "GET /runtime-info"

echo "docker smoke passed: http://127.0.0.1:$port"
