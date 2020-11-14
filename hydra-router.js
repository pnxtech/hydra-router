/**
* @name Service Router
* @description This is the service entry point
*/
'use strict';

const hydra = require('hydra');
const serviceRouter = require('./lib/servicerouter');

/**
 * @name setupExitHandlers
 * @description setup exit handlers
 * @return {undefined}
 */
let setupExitHandlers = () => {
  process.on('cleanup', async() => {
    await serviceRouter.shutdown();
    await hydra.shutdown();
    process.exit(-1);
  });

  process.on('SIGTERM', () => {
    hydra.log('fatal', 'Received SIGTERM');
    process.emit('cleanup');
  });
  process.on('SIGINT', () => {
    hydra.log('fatal', 'Received SIGINT');
    process.emit('cleanup');
  });
  process.on('unhandledRejection', (reason, _p) => {
    hydra.log('fatal', reason);
    process.emit('cleanup');
  });
  process.on('uncaughtException', (err) => {
    let stack = err.stack;
    delete err.__cached_trace__;
    delete err.__previous__;
    delete err.domain;
    hydra.log('fatal', {
      stack
    });
    process.emit('cleanup');
  });
};

/**
 * @name displayNetworkInterfaces
 * @description display network interaces
 * @return {undefined}
 */
let displayNetworkInterfaces = () => {
  const os = require('os');
  let interfaces = os.networkInterfaces();
  console.log('Detected IPv4 IPs:');
  Object.keys(interfaces).
    forEach((itf) => {
      interfaces[itf].forEach((interfaceRecord)=>{
        if (interfaceRecord.family === 'IPv4') {
          console.log(`* ${itf}: ${interfaceRecord.address} ${interfaceRecord.netmask}`);
        }
      });
    });
  console.log('');
};

/**
 * @name setupRoutes
 * @description setup RESTful API routes
 * @param {object} config - config object
 * @return {undefined}
 */
let setupRoutes = async(config) => {
  let routeList = [
    '[get]/',
    '[get]/index.css',
    '[get]/index.js',
    '[get]/fonts/glyphicons-halflings-regular.woff2',
    '[get]/fonts/glyphicons-halflings-regular.woff',
    '[get]/fonts/glyphicons-halflings-regular.ttf',
    '[get]/v1/router/health',
    '[get]/v1/router/list/:thing',
    '[get]/v1/router/version',
    '[get]/v1/router/clear',
    '[get]/v1/router/refresh',
    '[get]/v1/router/refresh/:service',
    '[get]/v1/router/log',
    '[get]/v1/router/stats',
    '[post]/v1/router/message',
    '[post]/v1/router/send',
    '[post]/v1/router/queue'
  ];
  await hydra.registerRoutes(routeList);
  let routesObj = await hydra.getAllServiceRoutes();
  routesObj = Object.assign(routesObj, config.externalRoutes);
  serviceRouter.init(config, routesObj);
};

/**
 * @name setupHydraListeners
 * @description setup hydra listeners
 * @return {undefined}
 */
let setupHydraListeners = () => {
  hydra.on('log', (entry) => {
    serviceRouter.log(entry.type, entry);
  });
  hydra.on('metric', (entry) => {
    let type = (entry.indexOf('unavailable') > -1) ? 'error' : 'info';
    serviceRouter.log(type, entry);
  });
};

/**
 * @name setupServer
 * @description setup HTTP server
 * @param {object} config - config object
 * @param {object} serviceInfo - service info object
 * @return {object} server - http server object
 */
let setupServer = (config, serviceInfo) => {
  const http = require('http');
  let server;
  try {
    server = http.createServer((request, response) => {
      serviceRouter.routeRequest(request, response)
        .catch((err) => {
          hydra.log('fatal', err);
        });
    });
    if (!config.hydra.serviceInterface) {
      server.listen(serviceInfo.servicePort);
    } else {
      server.listen(serviceInfo.servicePort, serviceInfo.serviceIP);
    }
  } catch (e) {
    process.exit(1);
  }
  return server;
};

/**
 * @name setupWebSocketServer
 * @description setup websocket server
 * @param {object} server - http server to bind to
 * @return {undefined}
 */
let setupWebSocketServer = (server) => {
  const WebSocketServer = require('ws').Server;
  let wss = new WebSocketServer({server: server});
  wss.on('connection', (ws, req) => {
    serviceRouter.sendConnectMessage(ws, null, req);

    ws.on('message', (message) => {
      serviceRouter.routeWSMessage(ws, message);
    });

    ws.on('close', () => {
      serviceRouter.wsDisconnect(ws);
    });

    ws.on('error', (error) => {
      try {
        hydra.log('info', {
          msg: `error detected from client ${ws.id} on ${ws.ipAddr}`
        });
        hydra.log('fatal', error);
      } catch (e) {
        hydra.log('fatal', error);
      }
    });
  });
};

/**
 * @name displayBanner
 * @description display fancy banner
 * @return {undefined}
 */
let displayBanner = () => {
  let banner = `
  _   _           _             ____             _
 | | | |_   _  __| |_ __ __ _  |  _ \\ ___  _   _| |_ ___ _ __
 | |_| | | | |/ _\` | '__/ _\` | | |_) / _ \\| | | | __/ _ \\ '__|
 |  _  | |_| | (_| | | | (_| | |  _ < (_) | |_| | ||  __/ |
 |_| |_|\\__, |\\__,_|_|  \\__,_| |_| \\_\\___/ \\__,_|\\__\\___|_|
        |___/`;
  console.log(banner);
};

/**
 * @name main
 * @description Load configuration file and initialize hydra app
 * @return {undefined}
 */
let main = async() => {
  try {
    let HydraLogger;
    let loggerType = '';

    let config = require('./config/config.json');

    if (config.hydra.plugins && config.hydra.plugins.hydraLogger) {
      HydraLogger = require('hydra-plugin-hls/hydra');
      loggerType = 'hydra';
    } else if (config.hydra.plugins && config.hydra.plugins.loggly) {
      HydraLogger = require('hydra-plugin-loggly/hydra');
      loggerType = 'loggly';
    }
    let hydraLogger = new HydraLogger();
    hydra.use(hydraLogger);

    let newConfig = await hydra.init(`${__dirname}/config/config.json`, false);
    config = newConfig;

    let serviceInfo = await hydra.registerService();
    let logEntry = `Starting service ${serviceInfo.serviceName}:${hydra.getInstanceVersion()} on ${serviceInfo.serviceIP}:${serviceInfo.servicePort}`;

    if (loggerType === 'logger') {
      let appLogger = hydraLogger.getLogger();
      hydra.log = (type, message) => {
        appLogger[type](message);
      };
    }

    if (loggerType === 'loggly') {
      hydraLogger.setHydra(hydra);
      hydraLogger.setConfig(config.hydra);
      hydraLogger.onServiceReady();
    }

    setupExitHandlers();
    displayBanner();
    displayNetworkInterfaces();

    await setupRoutes(config);

    hydra.log('info', {
      message: logEntry
    });

    setupHydraListeners();

    let server = await setupServer(config, serviceInfo);
    setupWebSocketServer(server);

    if (global.gc) {
      global.gc();
    } else {
      console.warn('No GC hook! Start Hydra-Router using `node --expose-gc hydra-router.js`.');
    }
  } catch (err) {
    let stack = err.stack;
    console.log(stack); // console log because Logger isn't available in this case.
    process.emit('cleanup');
  }
};

main();
