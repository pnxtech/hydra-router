VERSION_TAG=$(<VERSION)
cd ..
rm -rf node_modules
docker build -f Dockerfile.debug --no-cache=true --load -t hydra-router:$VERSION_TAG .

