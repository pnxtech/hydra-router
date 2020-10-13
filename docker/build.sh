VERSION_TAG=$(<VERSION)
cd ..
rm -rf node_modules
docker build --no-cache=true -t hydra-router:$VERSION_TAG .
