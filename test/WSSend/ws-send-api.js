'use strict';

const Promise = require('bluebird');
const hydra = require('hydra');
const Utils = require('fwsp-jsutils');
const UMFMessage = require('fwsp-umf-message');
const WebSocket = require('ws');

class ApiCommand {
  onConnect(ws, path) {
    let umf = UMFMessage.createMessage({
      'to': path,
      'from': 'client:/',
      'body': {}
    });
    ws.send(Utils.safeJSONStringify(umf));
  }

  onMessage(msg) {
    console.log(msg);
  }

  process() {
    let path = process.argv[2];

    let json = {
      'hydra': {
        'serviceName': 'WSSend client',
        'serviceDescription': 'Test client for sending message via Hydra Router',
        'serviceIP': '8999',
        'servicePort': 0,
        'serviceType': 'test',
        'redis': {
          'url': '127.0.0.1',
          'port': 6379,
          'db': 15
        }
      }
    };

    hydra.init(json.hydra)
      .then(() => {
        /**
        * obtain presence information for the hydra-router service.
        */
        hydra.getServicePresence('hydra-router')
          .then((info) => {
            console.log(info);
            let service = info[0];

            if (!service) {
              console.log('An instance of the hydra-router service can\'t be found.');
              process.exit(0);
            }

            let url = `ws://${service.ip}:${service.port}/`;
            let ws = new WebSocket(url);

            ws.on('open', () => {
              this.onConnect(ws, path);
            });

            ws.on('message', (data, flags) => {
              let msg = Utils.safeJSONParse(data);
              this.onMessage(msg);
            });
          });
      });
  }
}

(new ApiCommand).process();
