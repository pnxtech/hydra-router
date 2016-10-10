'use strict';

const WebSocket = require('ws');

let ws = new WebSocket('http://localhost:5353');

ws.on('open', () => {
  let umf = {
    'to': 'hydra-router:[GET]/v1/router/list/nodes',
    'from': 'client:/',
    'body': {}
  };
  ws.send(JSON.stringify(umf));
});

ws.on('message', (data, flags) => {
  console.log(data);
  process.exit();
});
