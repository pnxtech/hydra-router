VERSION_TAG=$(<VERSION)
SERVICE_NAME=hydra-router
cd ..
rm -rf node_modules
docker build -f Dockerfile.debug --no-cache=true -t $SERVICE_NAME:$VERSION_TAG .

