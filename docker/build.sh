VERSION_TAG=$(<VERSION)
SERVICE_NAME=hydra-router
SERVICE_HOST=pnxtech

cd ..
rm -rf node_modules

docker build --no-cache -t $SERVICE_HOST/$SERVICE_NAME:$VERSION_TAG-amd64 --build-arg ARCH=amd64 .
docker build --no-cache -t $SERVICE_HOST/$SERVICE_NAME:$VERSION_TAG-arm64 --build-arg ARCH=arm64 .

docker push $SERVICE_HOST/$SERVICE_NAME:$VERSION_TAG-amd64
docker push $SERVICE_HOST/$SERVICE_NAME:$VERSION_TAG-arm64

docker manifest create \
$SERVICE_HOST/$SERVICE_NAME:$VERSION_TAG \
--amend $SERVICE_HOST/$SERVICE_NAME:$VERSION_TAG-amd64 \
--amend $SERVICE_HOST/$SERVICE_NAME:$VERSION_TAG-arm64 

docker manifest push $SERVICE_HOST/$SERVICE_NAME:$VERSION_TAG

