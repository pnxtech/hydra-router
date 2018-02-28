#!/bin/sh
export SWARM_NAME='hr'
sudo mv /etc/hosts.bak /etc/hosts
docker stack rm ${SWARM_NAME}
