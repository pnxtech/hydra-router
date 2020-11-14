'use strict';

const os = require('os');
const Promise = require('bluebird');
const hydra = require('hydra');
const UMFMessage = hydra.getUMFMessageHelper();
const Utils = hydra.getUtilsHelper();
const ServerResponse = hydra.getServerResponseHelper();
const serverResponse = new ServerResponse;
const zlib = require('zlib');
const url = require('url');
const path = require('path');
const fs = require('fs');
const querystring = require('querystring');
const Route = require('route-parser');
const version = require('../package.json').version;
const Queuer = require('./queuer');
const Stats = require('./stats');

const INFO = 'info';
const ERROR = 'error';
const FATAL = 'fatal';
const FIVE_SECONDS = 5;
const MAX_ISSUE_LOG_ENTRIES = 100;
const ISSUE_LOG_CLEANUP_DELAY = 30000; // thirty seconds
const MAX_SERVICE_LOG_LENGTH = 3;
const GC_INTERVAL = 60000; // every one minute
const HR_MESSAGE_QUEUE = 'hydra-router:message:queue';

/**
* @name ServiceRouter
* @description A module which uses Hydra to route service requests.
*/
class ServiceRouter {
  /**
  * @name constructor
  * @return {undefined}
  */
  constructor() {
    this.config = null;
    this.routerTable = null;
    this.serviceNames = {};
    this.issueLog = [];
    this.issueLogCleanupScheduled = false;
    this._handleIncomingChannelMessage = this._handleIncomingChannelMessage.bind(this);

    this.wsStats = new Stats();
    this.httpStats = new Stats();
    this.errorStats = new Stats();

    // control node V8 garbage collection
    // In the future use metrics tracking to determine a more intelligent and dynamic interval.
    if (global.gc) {
      setInterval(() => {
        global.gc();
      }, GC_INTERVAL);
    }
  }

  /**
  * @name init
  * @summary Initialize the service router using a route object
  * @param {object} config - configuration object
  * @param {object} routesObj - routes object
  * @return {undefined}
  */
  init(config, routesObj) {
    this.config = config;
    this.requestTimeout = this.config.requestTimeout || FIVE_SECONDS;
    this.serviceName = hydra.getServiceName();
    this.serviceIntanceID = hydra.getInstanceID();
    this.wsLocalClients = {};
    this.wsClients = {
      [this.serviceIntanceID]: {}
    };

    Object.keys(routesObj).forEach((serviceName) => {
      let newRouteItems = [];
      let routes = routesObj[serviceName];
      routes.forEach((routePattern) => {
        this.debugLog(INFO, `HR: ${serviceName} adding ${routePattern}`);
        let idx = routePattern.indexOf(']');
        if (idx > -1) {
          routePattern = routePattern.substring(idx + 1);
        }
        newRouteItems.push({
          pattern: routePattern,
          route: new Route(routePattern)
        });
      });
      routesObj[serviceName] = newRouteItems;
    });
    hydra.on('message', this._handleIncomingChannelMessage);

    this.queuer = new Queuer();
    let queuerDB = config.hydra.queuerDB ? config.hydra.queuerDB : 0;
    this.queuer.init(hydra.getClonedRedisClient(), queuerDB);

    this.hostName = os.hostname();
    this.routerTable = routesObj;
    this._refreshRoutes();

    hydra.sendBroadcastMessage(UMFMessage.createMessage({
      to: `${this.serviceName}:/`,
      from: `${this.serviceIntanceID}@${this.serviceName}:/`,
      type: 'wsdir.sha',
      body: {
        routerID: this.serviceIntanceID
      }
    }));

    serverResponse.enableCORS(true, this.config.cors);
  }

  /**
  * @name shutdown
  * @summary shutdown service router
  * @return {object} Promise - promise resolving if success or rejection otherwise
  */
  shutdown() {
    return new Promise((resolve, _reject) => {
      hydra.sendBroadcastMessage(UMFMessage.createMessage({
        to: `${this.serviceName}:/`,
        from: `${this.serviceIntanceID}@${this.serviceName}:/`,
        type: 'wsdir.rem',
        body: {
          routerID: this.serviceIntanceID
        }
      }));
      setTimeout(() => {
        resolve();
      }, 1000);
    });
  }

  /**
  * @name log
  * @summary log a message
  * @param {string} type - type (info, error, fatal)
  * @param {string} message - message to log
  * @return {undefined}
  */
  log(type, message) {
    if (hydra.log) {
      hydra.log(type, message);
    }
    this.issueLog.push({
      ts: new Date().toISOString(),
      type,
      entry: (typeof message === 'object') ? Utils.safeJSONStringify(message) : message
    });
    let len = this.issueLog.length;
    if (len > MAX_ISSUE_LOG_ENTRIES && !this.issueLogCleanupScheduled) {
      this.issueLogCleanupScheduled = true;
      setTimeout(() => {
        this.issueLog.splice(0, len - MAX_ISSUE_LOG_ENTRIES);
        this.issueLogCleanupScheduled = false;
      }, ISSUE_LOG_CLEANUP_DELAY);
    }
  }

  /**
  * @name debugLog
  * @summary debug log a message
  * @param {string} type - type (info, error, fatal)
  * @param {string} message - message to log
  * @return {undefined}
  */
  debugLog(type, message) {
    if (this.config.debugLogging) {
      this.log(type, message);
    }
  }

  /**
  * @name _sendWSMessage
  * @summary send websocket message in short UMF format
  * @param {object} ws - websocket
  * @param {object} message - umf formatted message
  * @return {undefined}
  */
  _sendWSMessage(ws, message) {
    try {
      let msg = UMFMessage.createMessage(message);
      ws.send(Utils.safeJSONStringify(msg.toShort()));
    } catch (e) {
      this.wsDisconnect(ws);
      this.debugLog(FATAL, e);
    }
  }

  /**
  * @name _handleIncomingChannelMessage
  * @summary Handle incoming UMF messages from other services
  * @param {object} msg - UMF formatted message
  * @return {undefined}
  */
  _handleIncomingChannelMessage(msg) {
    this.debugLog(INFO, `HR: Incoming channel message: ${Utils.safeJSONStringify(msg)}`);
    this.debugLog(INFO, msg);
    let message = UMFMessage.createMessage(msg);
    if (message.body && message.body.action === 'refresh') {
      this._refreshRoutes(message.body.serviceName);
      return;
    }

    if (message.body && message.body.routerID && message.body.routerID !== this.serviceIntanceID) {
      if (!this.wsClients[message.body.routerID]) {
        this.wsClients[message.body.routerID] = {};
      }
      switch (message.type) {
        case 'wsdir.add': // add client to directory
          this.wsClients[message.body.routerID][message.body.clientID] = 1;
          break;
        case 'wsdir.del': // remove client from directory
          delete this.wsClients[message.body.routerID][message.body.clientID];
          break;
        case 'wsdir.rem': // remove directory for remote hydra router instance
          delete this.wsClients[message.body.routerID];
          break;
        case 'wsdir.sha': // share directory with remote hydra router instance
          hydra.sendBroadcastMessage(UMFMessage.createMessage({
            to: `${message.body.routerID}@${this.serviceName}:/`,
            from: `${this.serviceIntanceID}@${this.serviceName}:/`,
            type: 'wsdir.dir',
            body: {
              routerID: this.serviceIntanceID,
              directory: this.wsClients[this.serviceIntanceID]
            }
          }));
          break;
        case 'wsdir.dir': // add remote hydra router directory to this router instance
          this.wsClients[message.body.routerID] = message.body.directory;
          break;
        default:
          break;
      }
      return;
    }

    if (message.via) {
      let found = false;
      let viaRoute = UMFMessage.parseRoute(message.via);
      if (viaRoute.subID) {
        let ws = this.wsLocalClients[viaRoute.subID];
        if (ws) {
          delete msg.via;
          this._sendWSMessage(ws, msg);
          found = true;
        }
      }
      if (!found) {
        this.debugLog(INFO, `HR: Warning, queuing message ${Utils.safeJSONStringify(msg)}`);
        this.debugLog(INFO, msg);
        this.queuer.enqueue(`${HR_MESSAGE_QUEUE}:${viaRoute.subID}`, msg);
      }
    } else if (message.forward) {
      let found = false;
      let {instance} = UMFMessage.parseRoute(message.forward);
      if (this.wsLocalClients[instance]) {
        let ws = this.wsLocalClients[instance];
        if (ws) {
          this._sendWSMessage(ws, msg);
          found = true;
        }
      }
      if (!found) {
        this.debugLog(INFO, `HR: Warning, queuing message ${Utils.safeJSONStringify(msg)}`);
        this.debugLog(INFO, msg);
        this.queuer.enqueue(`${HR_MESSAGE_QUEUE}:${instance}`, msg);
      }
    }
  }

  /**
  * @name wsRouteThroughHttp
  * @summary Route websocket request through HTTP
  * @param {object} ws - websocket
  * @param {object} message - UMF message
  * @return {undefined}
  */
  async wsRouteThroughHttp(ws, message) {
    let longMessage = UMFMessage.createMessage(message);
    let replyMessage = UMFMessage.createMessage({
      to: longMessage.from,
      from: longMessage.to,
      rmid: longMessage.mid,
      body: {}
    });

    try {
      let data = await hydra.makeAPIRequest(longMessage.toJSON(), {timeout: this.requestTimeout});
      replyMessage.body = {};
      if (data.payLoad) {
        replyMessage.body = data.payLoad.toString('utf8');
      } else if (data.result) {
        replyMessage.body = data.result;
      }
      this._sendWSMessage(ws, replyMessage.toJSON());
      this.debugLog(INFO, `HR: WS passthrough response for ${Utils.safeJSONStringify(longMessage)} IS ${Utils.safeJSONStringify(replyMessage)}`);
      this.debugLog(INFO, longMessage);
      this.debugLog(INFO, replyMessage);
    } catch (err) {
      let parsedRoute = UMFMessage.parseRoute(message.to);
      this.errorStats.log(parsedRoute.serviceName);
      this.log(FATAL, err);
      let reason;
      if (err.result && err.result.reason) {
        reason = err.result.reason;
      } else {
        reason = err.message;
      }
      replyMessage.body = {
        error: true,
        result: reason
      };
      this._sendWSMessage(ws, replyMessage.toJSON());
    }
  }

  /**
  * @name sendConnectMessage
  * @summary Send a message on socket connect
  * @param {object} ws - websocket
  * @param {number} id - connection id if any
  * @param {object} req - HTTP request
  * @return {undefined}
  */
  sendConnectMessage(ws, id, req) {
    ws.id = id || Utils.shortID();
    if (!this.wsLocalClients[ws.id]) {
      this.wsLocalClients[ws.id] = ws;
      this.wsClients[this.serviceIntanceID][ws.id] = 1;

      hydra.sendBroadcastMessage(UMFMessage.createMessage({
        to: `${this.serviceName}:/`,
        from: `${this.serviceIntanceID}@${this.serviceName}:/`,
        type: 'wsdir.add',
        body: {
          routerID: this.serviceIntanceID,
          clientID: ws.id
        }
      }));
    }
    let ip;
    try {
      if (req && req.headers && req.headers['x-forwarded-for']) {
        ip = req.headers['x-forwarded-for'];
      } else {
        if (req.connection !== null && req.connection.remoteAddress !== null) {
          ip = req.connection.remoteAddress;
        }
      }
    } catch (e) {
      ip = 'unknown';
    }
    ws.ipAddr = ip;
    this.debugLog(INFO, `HR: sendConnectMessage detected IP: ${ip}`);
    let welcomeMessage = UMFMessage.createMessage({
      to: `${ws.id}@client:/`,
      from: `${this.serviceIntanceID}@${this.serviceName}:/`,
      type: 'connection',
      body: {
        id: ws.id,
        ip
      }
    });
    this.debugLog(INFO, `HR: Sending connection message to new websocket client ${Utils.safeJSONStringify(welcomeMessage)}`);
    this.debugLog(INFO, welcomeMessage);
    this._sendWSMessage(ws, welcomeMessage.toJSON());
  }

  /**
  * @name routeWSMessage
  * @summary Route a websocket message
  * @param {object} ws - websocket
  * @param {string} message - UMF message in string format
  * @return {undefined}
  */
  routeWSMessage(ws, message) {
    let invalidMessage = (msg, errorMsg) => {
      msg = typeof msg === 'string' ? msg : Utils.safeJSONStringify(msg);
      let errMessage = (!errorMsg) ? `HR: Invalid UMF message: ${msg} closing connection` : errorMsg;
      this.debugLog(INFO, errMessage);
      this._sendWSMessage(ws, UMFMessage.createMessage({
        to: 'client:/',
        from: `${this.serviceIntanceID}@${this.serviceName}:/`,
        bdy: {
          error: errMessage
        }
      }).toJSON());
    };

    let msg = Utils.safeJSONParse(message);
    if (!msg) {
      invalidMessage(message);
      this.wsDisconnect(ws);
      return;
    }

    // convert msg JSON object to an actual UMF (class) object
    msg = UMFMessage.createMessage(msg);
    if (!msg.to || !msg.from || !msg.body) {
      invalidMessage(msg);
      this.wsDisconnect(ws);
      return;
    }

    let toRoute = UMFMessage.parseRoute(msg.to);
    this.wsStats.log(toRoute.serviceName);

    this.debugLog(INFO, `HR: Incoming WS message: ${message}`);
    this.debugLog(INFO, message);

    // handle signed messages
    if (this.config.forceMessageSignature) {
      let oldSig = msg.signature;
      if (oldSig) {
        msg.signMessage('sha256', this.config.signatureSharedSecret);
        if (oldSig !== msg.signature) {
          invalidMessage(message, 'Invalid signed UMF message');
          this.wsDisconnect(ws);
          return;
        }
      } else {
        invalidMessage(message, 'Not a signed UMF message');
        this.wsDisconnect(ws);
        return;
      }
    }

    if (msg.to.indexOf('[') > -1 && msg.to.indexOf(']') > -1) {
      // does route point to an HTTP method? If so, route through HTTP
      // i.e. [get] [post] etc...
      if (toRoute.serviceName === this.serviceName) {
        this._handleRouterRequestWS(ws, toRoute);
      } else {
        this.wsRouteThroughHttp(ws, msg.toJSON());
      }
    } else {
      if (toRoute.serviceName === this.serviceName) {
        switch (msg.type) {
          case 'log': {
            this.log(INFO, msg.toJSON());
            return;
          }
          case 'ping': {
            this._sendWSMessage(ws, UMFMessage.createMessage({
              to: msg.from,
              rmid: msg.mid,
              typ: 'pong',
              body: {
                typ: 'pong'
              }
            }).toJSON());
            return;
          }
          case 'reconnect': {
            if (!msg.body.id) {
              invalidMessage(message, 'reconnect message missing reconnect id');
              this.wsDisconnect(ws);
              return;
            }
            this.debugLog(INFO, `HR: WS reconnecting to ${msg.body.id}`);

            delete this.wsLocalClients[ws.id];
            if (this.wsClients[this.serviceIntanceID][ws.id]) {
              delete this.wsClients[this.serviceIntanceID][ws.id];
            }
            hydra.sendBroadcastMessage(UMFMessage.createMessage({
              to: `${this.serviceName}:/`,
              from: `${this.serviceIntanceID}@${this.serviceName}:/`,
              type: 'wsdir.del',
              body: {
                routerID: this.serviceIntanceID,
                clientID: ws.id
              }
            }));

            this.sendConnectMessage(ws, msg.body.id, null);
            let iid = setInterval(() => {
              let queueName = `${HR_MESSAGE_QUEUE}:${msg.body.id}`;
              this.queuer.dequeue(queueName)
                .then((obj) => {
                  if (!obj) {
                    clearInterval(iid);
                  } else {
                    this._sendWSMessage(ws, UMFMessage.createMessage(obj).toJSON());
                    this.queuer.complete(queueName, obj);
                  }
                });
            }, 0);
            return;
          }
          case 'wsdir.loc':
            {
              // locate a client on directory
              let foundClient = false;
              for (let routerID of Object.keys(this.wsClients)) {
                if (this.wsClients[routerID][msg.body.clientID]) {
                  this._sendWSMessage(ws, UMFMessage.createMessage({
                    to: msg.from,
                    rmid: msg.mid,
                    body: {
                      routerID,
                      clientID: msg.body.clientID
                    }
                  }).toJSON());
                  foundClient = true;
                  break;
                }
              }
              if (!foundClient) {
                this._sendWSMessage(ws, UMFMessage.createMessage({
                  to: msg.from,
                  rmid: msg.mid,
                  body: {
                    routerID: '',
                    clientID: msg.body.clientID
                  }
                }).toJSON());
              }
            }
            return;
          default:
            break;
        }
        if (msg.forward) {
          let {instance} = UMFMessage.parseRoute(msg.forward);
          if (this.wsLocalClients[instance]) {
            let ws = this.wsLocalClients[instance];
            if (ws) {
              msg.to = msg.forward;
              msg.via = `${this.serviceIntanceID}@${this.serviceName}:/`;
              this._sendWSMessage(ws, msg.toJSON());
            } else {
              this.debugLog(INFO, `HR: Warning queuing message ${Utils.safeJSONStringify(msg)}`);
              this.debugLog(INFO, msg);
              this.queuer.enqueue(`${HR_MESSAGE_QUEUE}:${instance}`, msg);
            }
          } else {
            let foundRouter = false;
            let foundRouterID = '';
            for (let routerID of Object.keys(this.wsClients)) {
              if (this.wsClients[routerID][instance]) {
                foundRouter = true;
                foundRouterID = routerID;
                break;
              }
            }
            if (foundRouter) {
              hydra.getServicePresence(this.serviceName)
                .then((results) => {
                  let foundClient = false;
                  for (let hrInstance of results) {
                    if (hrInstance.instanceID === foundRouterID) {
                      msg.to = `${hrInstance.instanceID}@${this.serviceName}:/`;
                      hydra.sendMessage(msg);
                      foundClient = true;
                      break;
                    }
                  }
                  if (!foundClient) {
                    this.debugLog(INFO, `HR: Warning queuing message ${Utils.safeJSONStringify(msg)}`);
                    this.debugLog(INFO, msg);
                    this.queuer.enqueue(`${HR_MESSAGE_QUEUE}:${instance}`, msg);
                  }
                });
            } else {
              this.debugLog(INFO, `HR: Warning queuing message ${Utils.safeJSONStringify(msg)}`);
              this.debugLog(INFO, msg);
              this.queuer.enqueue(`${HR_MESSAGE_QUEUE}:${instance}`, msg);
            }
          }
          return;
        } else {
          invalidMessage(message, 'Unrecognized Hydra Router request');
          this.wsDisconnect(ws);
          return;
        }
      }

      if (toRoute.instance !== '') {
        let viaRoute = `${this.serviceIntanceID}-${ws.id}@${this.serviceName}:/`;
        let newMessage = Object.assign(msg.toJSON(), {
          via: viaRoute,
          from: msg.from
        });
        hydra.sendMessage(newMessage);
      } else {
        hydra.getServicePresence(toRoute.serviceName)
          .then((results) => {
            if (!results.length) {
              this.errorStats.log(toRoute.serviceName);
              invalidMessage(message, `No ${toRoute.serviceName} instances available`);
            } else {
              let newMsg = UMFMessage.createMessage({
                mid: msg.mid,
                to: `${results[0].instanceID}@${results[0].serviceName}:${toRoute.apiRoute}`,
                via: `${this.serviceIntanceID}-${ws.id}@${this.serviceName}:/`
              });
              let wsMsg = Object.assign(msg.toJSON(), newMsg.toJSON());
              hydra.sendMessage(wsMsg);
              this.debugLog(INFO, `HR: Routed WS message ${Utils.safeJSONStringify(wsMsg)}`);
              this.debugLog(INFO, wsMsg);
            }
          });
      }
    }
  }

  /**
  * @name wsDisconnect
  * @summary handle websocket disconnect
  * @param {object} ws - websocket
  * @return {undefined}
  */
  wsDisconnect(ws) {
    this.debugLog(INFO, `HR: WS close connection ${ws.id}`);
    delete this.wsLocalClients[ws.id];
    delete this.wsClients[this.serviceIntanceID][ws.id];

    hydra.sendBroadcastMessage(UMFMessage.createMessage({
      to: `${this.serviceName}:/`,
      from: `${this.serviceIntanceID}@${this.serviceName}:/`,
      type: 'wsdir.del',
      body: {
        routerID: this.serviceIntanceID,
        clientID: ws.id
      }
    }));
    ws.close();
  }

  /**
  * @name _matchRoute
  * @summary Matches a route url against router table
  * @private
  * @param {object} urlData - information about the url request
  * @return {object} routeInfo - object containing matching route info or null
  */
  _matchRoute(urlData) {
    for (let serviceName of Object.keys(this.routerTable)) {
      for (let routeEntry of this.routerTable[serviceName]) {
        let matchTest = routeEntry.route.match(urlData.pathname);
        if (matchTest) {
          return {
            serviceName,
            params: matchTest,
            pattern: routeEntry.pattern
          };
        }
      }
    }
    this.debugLog(INFO, `HR: ${urlData.pathname} was not matched to a route`);
    return null;
  }

  /**
  * @name routeRequest
  * @summary Routes a request to an available service
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
  * @return {object} Promise - promise resolving if success or rejection otherwise
  */
  routeRequest(request, response) {
    return new Promise((resolve, _reject) => {
      if (request.method === 'OPTIONS') {
        let extraHeaders = {
          'headers': {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Expose-Headers': 'Content-Length, Content-Range'
          }
        };
        serverResponse.sendResponse(ServerResponse.HTTP_NO_CONTENT, response, extraHeaders);
        return;
      }

      let tracer = Utils.shortID();
      if (this.config.debugLogging &&
          (request.url.indexOf('/v1/router') < 0) &&
          (request.headers['user-agent'] && request.headers['user-agent'].indexOf('ELB-HealthChecker') < 0)) {
        this.log(INFO, {
          tracer: `HR: tracer=${tracer}`,
          url: request.url,
          method: request.method,
          originalUrl: request.originalUrl,
          callerIP: request.headers['x-forwarded-for'] || request.connection.remoteAddress,
          body: (request.method === 'POST') ? request.body : {},
          host: request.headers['host'],
          userAgent: request.headers['user-agent']
        });
      }

      let requestUrl = request.url;
      let urlPath = `http://${request.headers['host']}${requestUrl}`;
      let urlData = url.parse(urlPath);

      if (request.url.indexOf('/v1/router') < 0) {
        if (this.config.debugLogging) {
          if (request.headers['referer']) {
            this.log(INFO, `HR: [${tracer}] Access ${urlPath} via ${request.headers['referer']}`);
            this.log(INFO, request.headers['referer']);
          } else {
            this.log(INFO, `HR: [${tracer}] Request for ${urlPath}`);
          }
        }
      }

      let matchResult = this._matchRoute(urlData);
      if (!matchResult) {
        if (request.headers['referer']) {
          let k = Object.keys(this.serviceNames);
          for (let i = 0; i < k.length; i += 1) {
            let serviceName = k[i];
            if (request.headers['referer'].indexOf(`/${serviceName}`) > -1) {
              matchResult = {
                serviceName
              };
              break;
            }
          }
        }
      }

      let segs = urlData.path.split('/');
      if (!matchResult) {
        if (this.serviceNames[segs[1]]) {
          matchResult = {
            serviceName: segs[1]
          };
          segs.splice(1, 1);
          requestUrl = segs.join('/');
          if (requestUrl === '/') {
            requestUrl = '';
          }
        }
      }

      if (!matchResult) {
        this.debugLog(ERROR, `HR: [${tracer}] No service match for ${request.url}`);
        serverResponse.sendNotFound(response);
        resolve();
        return;
      }

      // is this a hydra-router API call?
      if (matchResult.serviceName === this.serviceName) {
        this._handleRouterRequest(urlData, matchResult, request, response);
        resolve();
        return;
      }

      if (request.method === 'POST' || request.method === 'PUT') {
        let body = [];
        request.on('data', (data) => {
          body.push(data);
        });
        request.on('end', () => {
          let newBody = Buffer.concat(body);
          if (request.headers['content-encoding'] && request.headers['content-encoding'].includes('gzip')) {
            zlib.gunzip(newBody, (err, unzipped) => {
              if (err) {
                this.log(ERROR, err);
              } else {
                let newerBody = unzipped.toString('utf-8');
                this._processHTTPRequest(tracer, newerBody, matchResult.serviceName, requestUrl, request, response, resolve);
              }
            });
          } else {
            this._processHTTPRequest(tracer, newBody, matchResult.serviceName, requestUrl, request, response, resolve);
          }
        });
      } else {
        this._processHTTPRequest(tracer, null, matchResult.serviceName, requestUrl, request, response, resolve);
      }
    });
  }

  /**
  * @name _processHTTPRequest
  * @summary Process HTTP requests
  * @param {string} tracer - tag to mark HTTP call
  * @param {object} body - Body for POST and PUT calls
  * @param {string} serviceName - name of target service
  * @param {string} requestUrl - request url
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
  * @param {function} resolve - promise resolve handler
  * @return {undefined}
  */
  async _processHTTPRequest(tracer, body, serviceName, requestUrl, request, response, resolve) {
    this.httpStats.log(serviceName);

    let message = {
      to: `${serviceName}:[${request.method.toLowerCase()}]${requestUrl}`,
      from: `${this.serviceIntanceID}@${this.serviceName}:/`,
      headers: Object.assign({}, request.headers)
    };

    if (request.headers['content-type'] === 'application/x-www-form-urlencoded') {
      message.headers['content-type'] = 'application/json';
      try {
        message.body = querystring.parse(body.toString());
      } catch (e) {
        message.body = {};
      }
    } else {
      message.body = Utils.safeJSONParse(body) || {};
    }

    if (request.headers['authorization']) {
      message.authorization = request.headers['authorization'];
    }

    // don't pass encoding / compression headers to remote service
    if (message.headers['accept-encoding'] && message.headers['accept-encoding'].includes('gzip')) {
      delete message.headers['accept-encoding'];
    }
    if (message.headers['content-encoding'] && message.headers['content-encoding'].includes('gzip')) {
      delete message.headers['content-encoding'];
    }

    message.headers['x-hydra-tracer'] = tracer;
    let msg = UMFMessage.createMessage(message).toJSON();
    msg.mid = `${msg.mid}-${tracer}`;

    this.debugLog(INFO, `HR: [${tracer}] Calling remote service ${Utils.safeJSONStringify(msg)}`);
    this.debugLog(INFO, msg);

    try {
      let data = await hydra.makeAPIRequest(msg, {timeout: this.requestTimeout});
      if (data.statusCode > 201) {
        this.errorStats.log(serviceName);
      }
      if (data.statusCode > 399 && data.statusCode < 500) {
        this.log(ERROR, `HR: [${tracer}] ${serviceName} reported: HTTP:${data.statusCode}`);
      }
      if (data.statusCode > 499) {
        this.log(FATAL, `HR: [${tracer}] ${serviceName} reported: HTTP:${data.statusCode}`);
      }
      if (data.headers) {
        let headers = Object.assign({
          'x-hydra-tracer': tracer
        }, data.headers, this.config.cors || {});

        let ct = headers['content-type'];
        if (ct && ct.indexOf('json') > -1) {
          delete data.headers;
          data = Object.assign(data, Utils.safeJSONParse(data.payLoad));
          delete data.payLoad;
          let newPayLoad;
          if (request.headers['accept-encoding'] && request.headers['accept-encoding'].includes('gzip')) {
            headers['content-encoding'] = 'gzip';
            newPayLoad = Buffer.from(Utils.safeJSONStringify(data), 'utf-8');
            zlib.gzip(newPayLoad, (err, compressData) => {
              headers['content-length'] = Buffer.byteLength(compressData);
              response.writeHead(data.statusCode, headers);
              response.end(compressData);
            });
          } else {
            newPayLoad = Utils.safeJSONStringify(data);
            headers['content-length'] = Buffer.byteLength(newPayLoad);
            response.writeHead(data.statusCode, headers);
            response.write(newPayLoad);
            response.end();
          }
        } else {
          response.writeHead(data.statusCode, headers);
          response.write(data.payLoad);
          response.end();
        }
      } else {
        serverResponse.sendResponse(data.statusCode, response, {
          result: {
            reason: data.result.reason
          },
          tracer
        });
      }
      resolve();
    } catch (err) {
      this.log(FATAL, `HR: [${tracer}] ERROR: ${err.message}`);
      this.log(FATAL, err);
      let msg = err.result.reason;
      serverResponse.sendResponse(err.statusCode, response, {
        result: {
          reason: msg
        },
        tracer
      });
      resolve();
    }
  }

  /**
  * @name _handleRouterRequest
  * @summary Handles requests intended for this router service.
  * @private
  * @param {object} urlData - parsed URL data
  * @param {object} matchResult - route match results
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
  * @return {undefined}
  */
  _handleRouterRequest(urlData, matchResult, request, response) {
    let allowRouterCall = !(this.config.disableRouterEndpoint === true);
    if (allowRouterCall && this.config.routerToken !== '') {
      let qs = querystring.parse(urlData.query);
      if (qs.token) {
        allowRouterCall = (Utils.isUUID4(qs.token) && qs.token === this.config.routerToken);
      } else {
        allowRouterCall = false;
      }
    }

    let resourcePath = urlData.pathname;
    if (resourcePath.endsWith('.css') ||
        resourcePath.endsWith('.js') ||
        resourcePath.endsWith('.ttf') ||
        resourcePath.endsWith('.woff') ||
        resourcePath.endsWith('.woff2')
    ) {
      allowRouterCall = true;
    }

    if (urlData.host !== 'localhost' && !allowRouterCall) {
      serverResponse.sendResponse(ServerResponse.HTTP_NOT_FOUND, response);
      return;
    }

    if (matchResult.pattern === '/') {
      let filePath = path.join(__dirname, '../public/index.html');
      let stat = fs.statSync(filePath);
      response.writeHead(ServerResponse.HTTP_OK, {
        'Content-Type': 'text/html',
        'Content-Length': stat.size
      });
      let readStream = fs.createReadStream(filePath);
      readStream.pipe(response);
      return;
    }

    let serveLocalFile = (localPath) => {
      let filePath = path.join(__dirname, localPath);
      let stat = fs.statSync(filePath);
      let mimetype = (filename) => {
        if (filename.endsWith('.js')) {
          return 'application/javascript';
        } else if (filename.endsWith('.css')) {
          return 'text/css';
        } else if (filename.endsWith('.woff2')) {
          return 'font/woff2';
        } else if (filename.endsWith('.woff')) {
          return 'font/woff';
        } else if (filename.endsWith('.ttf')) {
          return 'application/octet-stream';
        }
      };
      response.writeHead(ServerResponse.HTTP_OK, {
        'Content-Type': mimetype(localPath),
        'Content-Length': stat.size
      });
      let readStream = fs.createReadStream(filePath);
      readStream.pipe(response);
    };

    if (matchResult.pattern === '/index.js') {
      serveLocalFile('../public/index.js');
      return;
    }
    if (matchResult.pattern === '/index.css') {
      serveLocalFile('../public/index.css');
      return;
    }
    if (matchResult.pattern === '/fonts/glyphicons-halflings-regular.woff2') {
      serveLocalFile('../public/glyphicons-halflings-regular.woff2');
      return;
    }
    if (matchResult.pattern === '/fonts/glyphicons-halflings-regular.woff') {
      serveLocalFile('../public/glyphicons-halflings-regular.woff');
      return;
    }
    if (matchResult.pattern === '/fonts/glyphicons-halflings-regular.ttf') {
      serveLocalFile('../public/glyphicons-halflings-regular.ttf');
      return;
    }

    if (matchResult.pattern === '/v1/router/list/:thing') {
      if (matchResult.params.thing === 'routes') {
        this._handleRouteListRoutes(response);
      } else if (matchResult.params.thing === 'services') {
        this._handleRouteListServices(response);
      } else if (matchResult.params.thing === 'nodes') {
        this._handleRouteListNodes(response);
      } else if (matchResult.params.thing === 'wsdir') {
        this._handleRouteListWSDir(response);
      } else {
        serverResponse.sendNotFound(response);
      }
    } else if (matchResult.pattern.indexOf('/v1/router/clear') > -1) {
      this._clearServices(response);
    } else if (matchResult.pattern.indexOf('/v1/router/health') > -1) {
      this._handleHealth(response);
    } else if (matchResult.pattern.indexOf('/v1/router/refresh') > -1) {
      this._refreshRoutes(matchResult.params.service);
      serverResponse.sendOk(response);
    } else if (matchResult.pattern.indexOf('/v1/router/version') > -1) {
      this._handleRouteVersion(response);
    } else if (matchResult.pattern.indexOf('/v1/router/log') > -1) {
      this._handleRouteLog(response);
    } else if (matchResult.pattern.indexOf('/v1/router/stats') > -1) {
      this._handleRouteStats(response);
    } else if (matchResult.pattern.indexOf('/v1/router/message') > -1) {
      this._handleMessage(request, response);
    } else if (matchResult.pattern.indexOf('/v1/router/send') > -1) {
      this._handleSendMessage(request, response);
    } else if (matchResult.pattern.indexOf('/v1/router/queue') > -1) {
      this._handleQueueMessage(request, response);
    } else {
      serverResponse.sendNotFound(response);
      this.log(INFO, `HR: ${matchResult.pattern} was not matched to a route`);
    }
  }

  /**
  * @name _handleRouterRequestWS
  * @summary Handle router request via websockets
  * @private
  * @param {object} ws - websocket
  * @param {object} route - route request
  * @return {undefined}
  */
  _handleRouterRequestWS(ws, route) {
    let err = false;
    let responseMessage = UMFMessage.createMessage({
      to: `${ws.id}@client:/`,
      from: `${this.serviceIntanceID}@${this.serviceName}:/`,
      body: {}
    });

    if (route.apiRoute.indexOf('/v1/router/list') > -1) {
      if (route.apiRoute.indexOf('routes') > -1) {
        this._handleRouteListRoutes(null, ws, responseMessage);
      } else if (route.apiRoute.indexOf('services') > -1) {
        this._handleRouteListServices(null, ws, responseMessage);
      } else if (route.apiRoute.indexOf('nodes') > -1) {
        this._handleRouteListNodes(null, ws, responseMessage);
      } else if (route.apiRoute.indexOf('wsdir') < -1) {
        this._handleRouteListWSDir(null, ws, responseMessage);
      } else {
        err = true;
      }
    } else if (route.apiRoute.indexOf('/v1/router/clear') > -1) {
      this._clearServices(null, ws, responseMessage);
    } else if (route.apiRoute.indexOf('/v1/router/health') > -1) {
      this._handleHealth(null, ws, responseMessage);
    } else if (route.apiRoute.indexOf('/v1/router/refresh') > -1) {
      this._refreshRoutes(null, ws, responseMessage);
    } else if (route.apiRoute.indexOf('/v1/router/version') > -1) {
      this._handleRouteVersion(null, ws, responseMessage);
    } else if (route.apiRoute.indexOf('/v1/router/stats') > -1) {
      this._handleRouteStats(null, ws, responseMessage);
    } else {
      err = true;
    }

    if (err) {
      responseMessage.body = {
        error: `Route ${route.apiRoute} is not routable.`
      };
      this._sendWSMessage(ws, responseMessage.toJSON());
    }
  }

  /**
  * @name _handleRouteVersion
  * @summary Handle version request. /v1/router/version.
  * @private
  * @param {object} response - Node HTTP response object
  * @param {object} ws - websocket object
  * @param {object} responseMessage - WS message to use for response
  * @return {undefined}
  */
  _handleRouteVersion(response, ws, responseMessage) {
    if (response) {
      serverResponse.sendOk(response, {
        result: {
          version
        }
      });
    } else {
      responseMessage.body = {version};
      this._sendWSMessage(ws, responseMessage.toJSON());
    }
  }

  /**
  * @name _handleHealth
  * @summary Handle health request.
  * @private
  * @param {object} response - Node HTTP response object
  * @param {object} ws - websocket object
  * @param {object} responseMessage - WS message to use for response
  * @return {undefined}
  */
  _handleHealth(response, ws, responseMessage) {
    let healthInfo = hydra.getHealth();
    if (response) {
      serverResponse.sendOk(response, {
        result: healthInfo
      });
    } else {
      responseMessage.body = healthInfo;
      this._sendWSMessage(ws, responseMessage.toJSON());
    }
  }

  /**
  * @name _handleRouteLog
  * @summary Handle log routes requests. /v1/router/log
  * @private
  * @param {object} response - Node HTTP response object
  * @param {object} ws - websocket object
  * @param {object} responseMessage - WS message to use for response
  * @return {undefined}
  */
  _handleRouteLog(response, ws, responseMessage) {
    let result = {
      logs: this.issueLog
    };
    if (response) {
      serverResponse.sendOk(response, {
        result
      });
    } else {
      responseMessage.body = result;
      this._sendWSMessage(ws, responseMessage.toJSON());
    }
  }

  /**
  * @name _handleRouteStats
  * @summary Handle stats routes requests. /v1/router/stats
  * @private
  * @param {object} response - Node HTTP response object
  * @param {object} ws - websocket object
  * @param {object} responseMessage - WS message to use for response
  * @return {undefined}
  */
  _handleRouteStats(response, ws, responseMessage) {
    let httpStats = this.httpStats.getRawStats();
    let wsStats = this.wsStats.getRawStats();
    let errorStats = this.errorStats.getRawStats();

    let result = {
      httpStats,
      wsStats,
      errorStats
    };

    if (response) {
      serverResponse.sendOk(response, {
        result
      });
    } else {
      responseMessage.body = result;
      this._sendWSMessage(ws, responseMessage.toJSON());
    }
  }

  /**
  * @name _handleRouteListRoutes
  * @summary Handle list routes requests. /v1/router/list/routes.
  * @private
  * @param {object} response - Node HTTP response object
  * @param {object} ws - websocket object
  * @param {object} responseMessage - WS message to use for response
  * @return {undefined}
  */
  _handleRouteListRoutes(response, ws, responseMessage) {
    let routeList = [];
    for (let route of Object.keys(this.routerTable)) {
      let routes = [];
      for (let routeElement of this.routerTable[route]) {
        routes.push(routeElement.pattern);
      }
      routeList.push({
        serviceName: route,
        routes
      });
    }
    if (response) {
      serverResponse.sendOk(response, {
        result: routeList
      });
    } else {
      responseMessage.body = routeList;
      this._sendWSMessage(ws, responseMessage.toJSON());
    }
  }

  /**
  * @name _handleRouteListServices
  * @summary Handle list services requests. /v1/router/list/services.
  * @private
  * @param {object} response - Node HTTP response object
  * @param {object} ws - websocket object
  * @param {object} responseMessage - WS message to use for response
  * @return {undefined}
  */
  async _handleRouteListServices(response, ws, responseMessage) {
    let findItemData = (space, key, instanceID) => {
      if (!space[key]) {
        return {};
      }
      return space[key].find((item) => item.instanceID === instanceID);
    };

    try {
      let result = await hydra.getServiceHealthAll();
      let serviceInstanceDataItems = [];
      result.forEach((service) => {
        service.presence.forEach((instance) => {
          let instanceID = instance.instanceID;
          let serviceInstanceData = Object.assign({},
            findItemData(service, 'presence', instanceID),
            findItemData(service, 'instance', instanceID),
            findItemData(service, 'health', instanceID)
          );
          if (service.log) {
            if (service.log.length > MAX_SERVICE_LOG_LENGTH) {
              service.log.length = MAX_SERVICE_LOG_LENGTH;
            }
            serviceInstanceData.log = service.log;
          }
          serviceInstanceDataItems.push(serviceInstanceData);
        });
      });
      if (response) {
        serverResponse.sendOk(response, {
          result: serviceInstanceDataItems
        });
      } else {
        responseMessage.body = serviceInstanceDataItems;
        this._sendWSMessage(ws, responseMessage.toJSON());
      }
    } catch (err) {
      this.log(FATAL, err);
      if (response) {
        serverResponse.sendServerError(response, {
          result: {
            reason: err.message
          }
        });
      } else {
        responseMessage.body = {
          error: err.message
        };
        this._sendWSMessage(ws, responseMessage.toJSON());
      }
    }
  }

  /**
  * @name _handleRouteListNodes
  * @summary Handle request to list nodes
  * @private
  * @param {object} response - Node HTTP response object
  * @param {object} ws - websocket object
  * @param {object} responseMessage - WS message to use for response
  * @return {undefined}
  */
  async _handleRouteListNodes(response, ws, responseMessage) {
    try {
      let nodes = await hydra.getServiceNodes();
      if (response) {
        serverResponse.sendOk(response, {
          instanceID: this.serviceIntanceID,
          hostname: this.hostName,
          version: hydra.getInstanceVersion(),
          result: nodes
        });
      } else {
        responseMessage.body = nodes;
        this._sendWSMessage(ws, responseMessage.toJSON());
      }
    } catch (err) {
      responseMessage.body = {
        error: err.message
      };
      this._sendWSMessage(ws, responseMessage.toJSON());
    }
  }

  /**
  * @name _handleRouteListWSDir
  * @summary Handle request to list wsdir
  * @private
  * @param {object} response - Node HTTP response object
  * @param {object} ws - websocket object
  * @param {object} responseMessage - WS message to use for response
  * @return {undefined}
  */
  _handleRouteListWSDir(response, ws, responseMessage) {
    if (response) {
      serverResponse.sendOk(response, {
        result: this.wsClients
      });
    } else {
      responseMessage.body = this.wsClients;
      this._sendWSMessage(ws, responseMessage.toJSON());
    }
  }

  /**
  * @name _handleMessage
  * @summary Route incoming UMF message.
  * @private
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
  * @return {undefined}
  */
  _handleMessage(request, response) {
    let umf = '';
    request.on('data', (data) => {
      umf += data;
    });
    request.on('end', async() => {
      try {
        umf = UMFMessage.createMessage(Utils.safeJSONParse(umf));
      } catch (err) {
        this.log(FATAL, `HR: ${err.message}`);
        this.log(FATAL, err);
        serverResponse.sendInvalidRequest(response);
        return;
      }
      try {
        let forwardMessage = UMFMessage.createMessage({
          to: umf.forward,
          from: `${this.serviceIntanceID}@${this.serviceName}:/`,
          body: umf.body
        });
        let data = await hydra.makeAPIRequest(forwardMessage.toJSON(), {timeout: this.requestTimeout});
        serverResponse.sendResponse(data.statusCode, response, {
          result: data.result
        });
      } catch (err) {
        this.log(FATAL, `HR: ${err.message}`);
        this.log(FATAL, err);
        serverResponse.sendResponse(err.statusCode, response, {
          result: {
            reason: err.message
          }
        });
      }
    });
  }

  /**
  * @name _handleSendMessage
  * @summary Route incoming HTTP UMF message.
  * @private
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
  * @return {undefined}
  */
  _handleSendMessage(request, response) {
    let umf = '';
    request.on('data', (data) => {
      umf += data;
    });
    request.on('end', async() => {
      try {
        umf = UMFMessage.createMessage(Utils.safeJSONParse(umf));
      } catch (err) {
        this.log(FATAL, `HR: ${err.message}`);
        this.log(FATAL, err);
        serverResponse.sendInvalidRequest(response);
        return;
      }
      hydra.sendMessage(umf);
      serverResponse.sendOk(response, {
        result: {
          mid: umf.mid
        }
      });
    });
  }

  /**
  * @name _handleQueueMessage
  * @summary Route incoming HTTP UMF message to a service queue
  * @private
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
  * @return {undefined}
  */
  _handleQueueMessage(request, response) {
    let umf = '';
    request.on('data', (data) => {
      umf += data;
    });
    request.on('end', async() => {
      try {
        umf = UMFMessage.createMessage(Utils.safeJSONParse(umf));
      } catch (err) {
        this.log(FATAL, `HR: ${err.message}`);
        this.log(FATAL, err);
        serverResponse.sendInvalidRequest(response);
        return;
      }
      hydra.queueMessage(umf);
      serverResponse.sendOk(response, {
        result: {
          mid: umf.mid
        }
      });
    });
  }

  /**
  * @name _clearServices
  * @summary Remove dead services to clear the dashboard
  * @param {object} response - Node HTTP response object
  * @param {object} ws - websocket object
  * @param {object} responseMessage - WS message to use for response
  * @return {undefined}
  */
  async _clearServices(response, ws, responseMessage) {
    let redirect = () => {
      const HTTP_FOUND = ServerResponse.HTTP_FOUND; // HTTP redirect
      if (response) {
        response.writeHead(HTTP_FOUND, {
          'Location': '/'
        });
        response.end();
      }
    };
    const FIVE_SECONDS = 5;
    try {
      let nodes = await hydra.getServiceNodes();
      let ids = [];
      nodes.forEach((node) => {
        if (node.elapsed > FIVE_SECONDS) {
          ids.push(node.instanceID);
        }
      });
      if (ids.length) {
        let redisClient = hydra.getClonedRedisClient();
        redisClient.hdel('hydra:service:nodes', ids, (_err, _result) => {
          if (response) {
            redirect();
          }
        });
        redisClient.quit();
      } else {
        if (response) {
          redirect();
        }
      }
      if (!response) {
        this._sendWSMessage(ws, responseMessage.toJSON());
      }
    } catch (err) {
      console.log(err);
      if (!response) {
        responseMessage.body = {
          error: err.message
        };
        this._sendWSMessage(ws, responseMessage.toJSON());
      }
    }
  }

  /**
  * @name _refreshRoutes
  * @summary Refresh router routes.
  * @param {string} service - if undefined then all service routes will be refreshed otherwise only the route for a specific service will be updated
  * @return {undefined}
  */
  async _refreshRoutes(service) {
    try {
      let routesObj = await hydra.getAllServiceRoutes();
      Object.keys(routesObj).forEach((serviceName) => {
        this.serviceNames[serviceName] = true;
        if (!service || service == serviceName) {
          let newRouteItems = [];
          let routes = routesObj[serviceName];
          routes.forEach((routePattern) => {
            let idx = routePattern.indexOf(']');
            if (idx > -1) {
              routePattern = routePattern.substring(idx + 1);
            }
            newRouteItems.push({
              pattern: routePattern,
              route: new Route(routePattern)
            });
          });
          this.routerTable[serviceName] = newRouteItems;
        }
      });
    } catch (err) {
      this.log(FATAL, `HR: ${err.message}`);
      this.log(FATAL, err);
    }
  }
}

module.exports = new ServiceRouter();
