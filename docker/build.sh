VERSION_TAG=$(<VERSION)
cd ..
rm -rf node_modules
docker buildx build --platform=linux/amd64 --load --no-cache -t hydra-router:$VERSION_TAG .
 
