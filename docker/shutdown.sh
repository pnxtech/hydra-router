export STACK_NAME='hr-cluster'
sudo sed '/[[:space:]]host/d' /etc/hosts > hosts.bak
sudo mv hosts.bak /etc/hosts
docker stack rm ${STACK_NAME}
