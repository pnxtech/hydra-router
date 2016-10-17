'use strict';

const WebSocket = require('ws');
const UMFMessage = require('fwsp-umf-message');

let ws = new WebSocket('http://192.168.1.10');

ws.on('open', () => {
  let umf = UMFMessage.createMessage({
    'to': 'hc-pylights:/',
    'from': 'client:/',
    'body': {
			'cmd': 'red'
		}
  });
  ws.send(JSON.stringify(umf));
});

ws.on('message', (data, flags) => {
  console.log(data);
  process.exit();
});
