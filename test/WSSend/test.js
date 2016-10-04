'use strict';

const WebSocket = require('ws');

let ws = new WebSocket('wss://gemini-staging.flywheelsports.com');

ws.on('open', () => {
  let umf = {
    'to': 'hydra-router:[GET]/v1/router/list/nodes',
    'from': 'client:/',
    'body': {}
  };
  ws.send(JSON.stringify(umf));
});

ws.on('message', (data, flags) => {
  let msg = JSON.parse(data);
  console.log(msg);
  process.exit();
});
