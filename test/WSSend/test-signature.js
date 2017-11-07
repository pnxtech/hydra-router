'use strict';

const WebSocket = require('ws');
const hydra = require('hydra');
const signatureSharedSecret = 'd632dd6d-fb75-44cc-bdbf-ee1364f3716c';

let ws = new WebSocket('http://localhost:5353');

ws.on('open', () => {
  let umf = hydra.createUMFMessage({
    'to': 'hydra-router:[GET]/v1/router/list/nodes',
    'from': 'client:/',
    'body': {}
  });
  umf.signMessage('sha256', signatureSharedSecret);
  ws.send(JSON.stringify(umf));
});

ws.on('message', (data, flags) => {
  console.log(data);
});
