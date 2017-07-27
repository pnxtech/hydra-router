/**
* @name Service Router
* @description This is the service entry point
*/
'use strict';

/**
* Router route list.
*/
let routeList = [
  '[get]/',
  '[get]/v1/router/list/:thing',
  '[get]/v1/router/version',
  '[get]/v1/router/clear',
  '[get]/v1/router/refresh',
  '[get]/v1/router/refresh/:service',
  '[get]/v1/router/stats',
  '[post]/v1/router/message'
];


const http = require('http');
const hydra = require('hydra');
const serviceRouter = require('./servicerouter');
const WebSocketServer = require('ws').Server;

const HydraLogger = require('fwsp-logger').HydraLogger;
let hydraLogger = new HydraLogger();
hydra.use(hydraLogger);
let appLogger;

let config = {};

/**
* Initialize hydra for use by Service Router.
*/
hydra.init(`${__dirname}/config/config.json`, false)
  .then((newConfig) => {
    config = newConfig;
    return hydra.registerService();
  })
  .then((serviceInfo) => {
    let logEntry = `Starting hydra-router service ${serviceInfo.serviceName}:${hydra.getInstanceVersion()} on ${serviceInfo.serviceIP}:${serviceInfo.servicePort}`;
    console.log(logEntry);
    hydra.sendToHealthLog('info', logEntry);

    appLogger = hydraLogger.getLogger();
    appLogger.info({
      msg: logEntry
    });

    hydra.on('log', (entry) => {
      serviceRouter.log(entry.type, entry);
    });

    hydra.on('metric', (entry) => {
      let type = (entry.indexOf('unavailable') > -1) ? 'error' : 'info';
      serviceRouter.log(type, entry);
    });

    process.on('cleanup', () => {
      hydra.shutdown();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      appLogger.fatal('Received SIGTERM');
      process.emit('cleanup');
    });
    process.on('SIGINT', () => {
      appLogger.fatal('Received SIGINT');
      process.emit('cleanup');
    });
    process.on('unhandledRejection', (reason, _p) => {
      appLogger.fatal(reason);
      process.emit('cleanup');
    });
    process.on('uncaughtException', (err) => {
      let stack = err.stack;
      delete err.__cached_trace__;
      delete err.__previous__;
      delete err.domain;
      appLogger.fatal({
        stack
      });
      process.emit('cleanup');
    });

    /**
    * @summary Start HTTP server and add request handler callback.
    * @param {object} request - Node HTTP request object
    * @param {object} response - Node HTTP response object
    */
    let server = http.createServer((request, response) => {
      serviceRouter.routeRequest(request, response)
        .catch((err) => {
          appLogger.fatal(err);
        });
    });
    server.listen(serviceInfo.servicePort);

    /**
    * Setup websocket message handler.
    */
    let wss = new WebSocketServer({server: server});
    wss.on('connection', (ws) => {
      serviceRouter.sendConnectMessage(ws);

      ws.on('message', (message) => {
        serviceRouter.routeWSMessage(ws, message);
      });

      ws.on('close', () => {
        serviceRouter.wsDisconnect(ws);
      });
    });

    /**
    * Register routes.
    */
    return hydra.registerRoutes(routeList);
  })
  .then(() => {
    /**
    * Retrieve routes for all registered services.
    */
    return hydra.getAllServiceRoutes();
  })
  .then((routesObj) => {
    /**
    * Initialize service router using routes object.
    */
    routesObj = Object.assign(routesObj, config.externalRoutes);
    serviceRouter.init(config, routesObj, appLogger);
    return null; // to silence promise warning: http://goo.gl/rRqMUw
  })
  .catch((err) => {
    console.log(err);
    process.exit(-1);
  });
