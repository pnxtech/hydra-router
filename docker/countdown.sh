#!/bin/bash
COUNTER=$1
while [ $COUNTER -gt 1 ]; do
  let COUNTER=COUNTER-1
  echo -ne "Seconds remaining: $COUNTER\033[0K\r"
  sleep 1
done
echo -ne "\033[0K\r"
