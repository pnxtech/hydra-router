COUNTER=$1
while [ $COUNTER -gt 1 ]; do
  let COUNTER=COUNTER-1
  echo "Seconds remaining: $COUNTER"
  sleep 1
done
echo ""
