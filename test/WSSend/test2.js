'use strict';

const WebSocket = require('ws');
const UMFMessage = require('fwsp-umf-message');

let ws = new WebSocket('http://192.168.1.10');

ws.on('open', () => {
  let umf = UMFMessage.create({
    'to': 'hc-pylights:/',
    'from': 'client:/',
    'body': {
			'cmd': 'red'
		}
  });
  ws.send(umf.toJSON());
});

ws.on('message', (data, flags) => {
  console.log(data);
  process.exit();
});
