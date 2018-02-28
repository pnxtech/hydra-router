#!/bin/sh
export SWARM_NAME='hr'
export HOST_IP=`echo "show State:/Network/Global/IPv4" | scutil | grep PrimaryInterface | awk '{print $3}' | xargs ifconfig | grep inet | grep -v inet6 | awk '{print $2}'`
echo "Binding ${SWARM_NAME} to ${HOST_IP}"

sudo cp /etc/hosts /etc/hosts.bak
sudo -- sh -c -e "echo '$HOST_IP\thost' >> /etc/hosts"

mkdir -p ~/data/${SWARM_NAME}
sudo SWARM_NAME=${SWARM_NAME} HOST_IP=${HOST_IP} HYDRA_REDIS_URL=redis://${HOST_IP}:6379/15 docker stack deploy --compose-file swarm-compose.yml --with-registry-auth ${SWARM_NAME}
