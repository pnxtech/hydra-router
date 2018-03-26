#!/bin/sh
source ~/.bash_profile
export STACK_NAME='hr'
export HOST_IP=`echo "show State:/Network/Global/IPv4" | scutil | grep PrimaryInterface | awk '{print $3}' | xargs ifconfig | grep inet | grep -v inet6 | awk '{print $2}'`
echo "Binding ${STACK_NAME} to ${HOST_IP}"

sudo -- sh -c -e "echo '$HOST_IP\thost' >> /etc/hosts"

mkdir -p ~/data/${STACK_NAME} ~/data/${STACK_NAME}/redis ~/data/${STACK_NAME}/elasticsearch ~/data/${STACK_NAME}/mongo

sudo STACK_NAME=${STACK_NAME} HOST_IP=${HOST_IP} docker stack deploy --compose-file base-stack-compose.yml --with-registry-auth ${STACK_NAME}
sleep 15
sudo STACK_NAME=${STACK_NAME} HOST_IP=${HOST_IP} docker stack deploy --compose-file stack-compose.yml --with-registry-auth ${STACK_NAME}
