#!/bin/sh
export SWARM_NAME='hr'
sudo sed '/[[:space:]]host/d' /etc/hosts > hosts.bak
sudo mv hosts.bak /etc/hosts
docker stack rm ${SWARM_NAME}
