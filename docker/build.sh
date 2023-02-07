VERSION_TAG=$(<VERSION)
SERVICE_NAME=hydra-router
SERVICE_HOST=pnxtech

cd ..
rm -rf node_modules

docker buildx create --use
docker buildx build --platform=linux/amd64,linux/arm64 --push --no-cache -t $SERVICE_HOST/$SERVICE_NAME:$VERSION_TAG .

