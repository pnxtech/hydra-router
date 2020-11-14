source ~/.bash_profile
export STACK_NAME='hr-cluster'
export HOST_IP=`echo "show State:/Network/Global/IPv4" | scutil | grep PrimaryInterface | awk '{print $3}' | xargs ifconfig | grep inet | grep -v inet6 | awk '{print $2}'`

echo "Binding ${STACK_NAME} to ${HOST_IP}"

sudo -- sh -c -e "echo '$HOST_IP\thost' >> /etc/hosts"
mkdir -p ./logs ~/data/${STACK_NAME}/redis

echo "\nStarting core services"

sudo STACK_NAME=${STACK_NAME} HOST_IP=${HOST_IP} docker stack deploy --compose-file stack-compose.yml --with-registry-auth ${STACK_NAME}

echo "\nopen http://localhost:5353"
