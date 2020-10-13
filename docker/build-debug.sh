VERSION_TAG=$(<VERSION)
cd ..
rm -rf node_modules
docker build -f Dockerfile.debug --no-cache=true -t hydra-router:$VERSION_TAG .
