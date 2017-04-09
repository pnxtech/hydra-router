rm -rf node_modules
docker build --no-cache=true -t $1/$2 .
docker push $1/$2
