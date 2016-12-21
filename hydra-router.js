/**
* @name Service Router
* @description This is the service entry point
*/
'use strict';

/**
* Router route list.
*/
let routeList = [
  '[get]/v1/router/list/:thing',
  '[get]/v1/router/version',
  '[get]/v1/router/refresh',
  '[get]/v1/router/refresh/:service',
  '[post]/v1/router/message'
];

let appLogger;
let config = require('fwsp-config');
config.init('./config/config.json')
  .then(() => {
    if (config.risingStack) {
      require('@risingstack/trace');
    }
    const http = require('http');
    const cluster = require('cluster');
    const os = require('os');
    const hydra = require('fwsp-hydra');
    const Utils = require('fwsp-jsutils');
    const version = require('./package.json').version;
    const serviceRouter = require('./servicerouter');
    const url = require('url');
    const WebSocketServer = require('ws').Server;
    config.version = version;
    config.hydra.serviceVersion = version;

    const HydraLogger = require('fwsp-logger').HydraLogger;
    let hydraLogger = new HydraLogger();
    hydra.use(hydraLogger);

    /**
    * Handling for process invocation as a process master or child process.
    */
    if (config.cluster !== true) {
      initWorker();
    } else {
      if (cluster.isMaster) {
        const numWorkers = config.processes || os.cpus().length;
        console.log(`${config.hydra.serviceName} (v.${config.version})`);
        console.log(`Using environment: ${config.environment}`);
        console.log('info', `Master cluster setting up ${numWorkers} workers...`);

        for (let i = 0; i < numWorkers; i++) {
          cluster.fork();
        }

        /**
         * @param {object} worker - worker process object
         */
        cluster.on('online', (worker) => {
          console.log(`Worker ${worker.process.pid} is online`);
        });

        /**
         * @param {object} worker - worker process object
         * @param {number} code - process exit code
         * @param {number} signal - signal that caused the process shutdown
         */
        cluster.on('exit', (worker, code, signal) => {
          console.log(`Worker ${worker.process.pid} died with code ${code}, and signal: ${signal}`);
          console.log('Starting a new worker');
          cluster.fork();
        });
      } else {
        initWorker();
      }
    }

    /**
    * @name initWorker
    * @summary Initialize the core process functionality.
    */
    function initWorker() {
      /**
      * Initialize hydra for use by Service Router.
      */
      hydra.init(config.hydra)
        .then(() => {
          return hydra.registerService();
        })
        .then((serviceInfo) => {
          let logEntry = `Starting hydra-router service ${serviceInfo.serviceName} on port ${serviceInfo.servicePort}`;
          hydra.sendToHealthLog('info', logEntry);
          console.log(logEntry);

          appLogger = hydraLogger.getLogger();

          process.on('uncaughtException', (err) => {
            let stack = err.stack;
            delete err.__cached_trace__;
            delete err.__previous__;
            delete err.domain;

            appLogger.fatal({
              stack
            });
            process.exit(1);
          });

          appLogger.info({
            msg: logEntry
          });

          hydra.on('log', (entry) => {
            appLogger[entry.type](entry);
          });

          /**
          * @summary Start HTTP server and add request handler callback.
          * @param {object} request - Node HTTP request object
          * @param {object} response - Node HTTP response object
          */
          let server = http.createServer((request, response) => {
            serviceRouter.routeRequest(request, response);
          });
          server.listen(serviceInfo.servicePort);

          /**
          * Setup websocket message handler.
          */
          let wss = new WebSocketServer({ server: server });
          wss.on('connection', (ws) => {
            serviceRouter.markSocket(ws);

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
          appLogger.fatal({
            stack: err.stack
          });
        });
    }
  });
