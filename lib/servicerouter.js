'use strict';

if (process.env.NEW_RELIC_LICENSE_KEY) {
  require('newrelic');
}

const debug = require('debug')('hydra-router');
const os = require('os');
const Promise = require('bluebird');
const hydra = require('hydra');
const UMFMessage = hydra.getUMFMessageHelper();
const Utils = hydra.getUtilsHelper();
const ServerResponse = hydra.getServerResponseHelper();
const serverResponse = new ServerResponse;

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
    this.wsClients = {};
    this.routerTable = null;
    this.serviceNames = {};
    this.appLogger = null;
    this.issueLog = [];
    this.issueLogCleanupScheduled = false;
    this._handleIncomingChannelMessage = this._handleIncomingChannelMessage.bind(this);
    serverResponse.enableCORS(true);

    this.wsStats = new Stats();
    this.httpStats = new Stats();
    this.errorStats = new Stats();

    // control node V8 garbage collection
    // In the future use metrics tracking to determine a more intelligent and dynamic interval.
    setInterval(() => {
      if (global.gc) {
        global.gc();
      }
    }, 30000);
  }

  /**
  * @name init
  * @summary Initialize the service router using a route object
  * @param {object} config - configuration object
  * @param {object} routesObj - routes object
  * @param {object} appLogger - logging object
  * @return {undefined}
  */
  init(config, routesObj, appLogger) {
    this.config = config;
    this.requestTimeout = this.config.requestTimeout || FIVE_SECONDS;
    this.serviceName = hydra.getServiceName();
    this.appLogger = appLogger;
    Object.keys(routesObj).forEach((serviceName) => {
      let newRouteItems = [];
      let routes = routesObj[serviceName];
      routes.forEach((routePattern) => {
        if (this.config.debugLogging) {
          this.log(INFO, `HR: ${serviceName} adding ${routePattern}`);
        }
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
  }

  /**
  * @name log
  * @summary log a message
  * @param {string} type - type (info, error, fatal)
  * @param {string} message - message to log
  * @return {undefined}
  */
  log(type, message) {
    let msg = (typeof message === 'object') ? Utils.safeJSONStringify(message) : message;
    debug(`${type} ${msg}`);

    if (type === ERROR || type === FATAL) {
      this.appLogger[type](message);
    } else if (this.config.debugLogging) {
      this.appLogger[type](message);
    }
    this.issueLog.push({
      ts: new Date().toISOString(),
      type,
      entry: message
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
    }
  }

  /**
  * @name _handleIncomingChannelMessage
  * @summary Handle incoming UMF messages from other services
  * @param {object} msg - UMF formatted message
  * @return {undefined}
  */
  _handleIncomingChannelMessage(msg) {
    if (this.config.debugLogging) {
      this.log(INFO, `HR: Incoming channel message: ${Utils.safeJSONStringify(msg)}`);
    }
    let message = UMFMessage.createMessage(msg);
    if (message.body.action === 'refresh') {
      this._refreshRoutes(message.body.serviceName);
      return;
    }
    if (message.via) {
      let viaRoute = UMFMessage.parseRoute(message.via);
      if (viaRoute.subID) {
        let ws = this.wsClients[viaRoute.subID];
        if (ws) {
          delete msg.via;
          this._sendWSMessage(ws, msg);
        } else {
          // websocket not found - it was likely closed, so queue the message for later retrieval
          this.queuer.enqueue(`hydra-router:message:queue:${viaRoute.subID}`, msg);
          this.log(ERROR, `Websocket ${viaRoute.subID} not found, queuing message`);
        }
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
  wsRouteThroughHttp(ws, message) {
    let longMessage = UMFMessage.createMessage(message);
    let replyMessage = UMFMessage.createMessage({
      to: longMessage.from,
      from: longMessage.to,
      rmid: longMessage.mid,
      body: {}
    });

    hydra.makeAPIRequest(longMessage.toJSON(), {timeout: this.requestTimeout})
      .then((data) => {
        replyMessage.body = {
          result: data.result
        };
        this._sendWSMessage(ws, replyMessage.toJSON());
        if (this.config.debugLogging) {
          this.log(INFO, `HR: WS passthrough response for ${Utils.safeJSONStringify(longMessage)} IS ${Utils.safeJSONStringify(replyMessage)}`);
        }
      })
      .catch((err) => {
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
      });
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
    if (!this.wsClients[ws.id]) {
      this.wsClients[ws.id] = ws;
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
    if (this.config.debugLogging) {
      this.log(INFO, `HR: sendConnectMessage detected IP: ${ip}`);
    }
    let welcomeMessage = UMFMessage.createMessage({
      to: `${ws.id}@client:/`,
      from: `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`,
      type: 'connection',
      body: {
        id: ws.id,
        ip
      }
    });
    if (this.config.debugLogging) {
      this.log(INFO, `HR: Sending connection message to new websocket client ${Utils.safeJSONStringify(welcomeMessage)}`);
    }
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
    let premsg = Utils.safeJSONParse(message);
    if (!premsg) {
      this.wsDisconnect(ws);
      return;
    }
    if (!premsg.to || !(premsg.from || premsg.frm) || !(premsg.body || premsg.bdy)) {
      this.wsDisconnect(ws);
      return;
    }

    let parsedRoute = UMFMessage.parseRoute(premsg.to);
    this.wsStats.log(parsedRoute.serviceName);

    if (this.config.debugLogging) {
      this.log(INFO, `HR: Incoming WS message: ${message}`);
    }

    let umf = UMFMessage.createMessage({
      'to': `client-${ws.id}:/`,
      'from': `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`
    });
    let msg = (premsg) ? UMFMessage.createMessage(premsg) : null;
    if (!msg) {
      umf.body = {
        error: `Unable to parse: ${message}`
      };
      this._sendWSMessage(ws, umf.toJSON());
      return;
    }

    if (!msg.validate()) {
      umf.body = {
        error: 'Message is not a valid UMF message'
      };
      this._sendWSMessage(ws, umf.toJSON());
      return;
    }

    // handle signed messages
    if (this.config.forceMessageSignature) {
      let badSig = (errorMessage) => {
        umf.body = {
          error: errorMessage
        };
        this._sendWSMessage(ws, umf.toJSON());
        setTimeout(() => {
          this.wsDisconnect(ws);
        }, 2000);
      };
      let oldSig = msg.signature || msg.sig;
      if (oldSig) {
        msg.signMessage('sha256', this.config.signatureSharedSecret);
        if (oldSig !== msg.signature) {
          badSig('Invalid signed UMF message');
          return;
        }
      } else {
        badSig('Not a signed UMF message');
        return;
      }
    }

    if (msg.to.indexOf('[') > -1 && msg.to.indexOf(']') > -1) {
      // does route point to an HTTP method? If so, route through HTTP
      // i.e. [get] [post] etc...
      let toRoute = UMFMessage.parseRoute(msg.to);
      if (toRoute.serviceName === 'hydra-router') {
        this._handleRouterRequestWS(ws, toRoute);
      } else {
        this.wsRouteThroughHttp(ws, msg.toJSON());
      }
    } else {
      switch (msg.type) {
        case 'log': {
          this.log(INFO, msg.toJSON());
          return;
        }
        case 'ping': {
          let newMsg = UMFMessage.createMessage({
            to: msg.from,
            rmid: msg.mid,
            body: {
              typ: 'pong'
            }
          });
          this._sendWSMessage(ws, newMsg.toJSON());
          return;
        }
        case 'reconnect': {
          if (!msg.body.id) {
            let umf = UMFMessage.createMessage({
              to: msg.from,
              from: `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`,
              body: {
                error: 'reconnect message missing reconnect id'
              }
            });
            this._sendWSMessage(ws, umf.toJSON());
          } else {
            this.sendConnectMessage(ws, msg.body.id, null);
            let iid = setInterval(() => {
              let queueName = `hydra-router:message:queue:${msg.body.id}`;
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
          }
          return;
        }
      }

      let toRoute = UMFMessage.parseRoute(msg.to);
      if (toRoute.instance !== '') {
        let viaRoute = `${hydra.getInstanceID()}-${ws.id}@${hydra.getServiceName()}:/`;
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
              umf.body = {
                error: `No ${toRoute.serviceName} instances available`
              };
              this._sendWSMessage(ws, umf.toJSON());
              if (this.config.debugLogging) {
                this.log(ERROR, `HR: Unable to route WS message because an instance of ${toRoute.serviceName} isn't available`);
              }
              return;
            }

            toRoute = UMFMessage.parseRoute(msg.to);
            let newMsg = UMFMessage.createMessage({
              mid: msg.mid,
              to: `${results[0].instanceID}@${results[0].serviceName}:${toRoute.apiRoute}`,
              via: `${hydra.getInstanceID()}-${ws.id}@${hydra.getServiceName()}:/`,
              body: msg.body,
              from: msg.from
            });
            let wsMsg = UMFMessage.createMessage(Object.assign({}, msg.toJSON(), newMsg.toJSON()));
            hydra.sendMessage(wsMsg.toJSON());
            if (this.config.debugLogging) {
              this.log(INFO, `HR: Routed WS message ${Utils.safeJSONStringify(wsMsg.toJSON())}`);
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
    ws.close();
    delete this.wsClients[ws.id];
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
    if (this.config.debugLogging) {
      this.log(INFO, `HR: ${urlData.pathname} was not matched to a route`);
    }
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
        this._handleCORSReqest(request, response);
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
        if (this.config.debugLogging) {
          this.log(ERROR, `HR: [${tracer}] No service match for ${request.url}`);
        }
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
        let body = '';
        request.on('data', (data) => {
          body += data;
        });
        request.on('end', () => {
          this._processHTTPRequest(tracer, body, matchResult.serviceName, requestUrl, request, response, resolve);
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
  _processHTTPRequest(tracer, body, serviceName, requestUrl, request, response, resolve) {
    this.httpStats.log(serviceName);

    let message = {
      to: `${serviceName}:[${request.method.toLowerCase()}]${requestUrl}`,
      from: `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`,
      headers: request.headers,
      body: Utils.safeJSONParse(body) || {}
    };
    if (request.headers['authorization']) {
      message.authorization = request.headers['authorization'];
    }
    message.headers['x-hydra-tracer'] = tracer;
    let msg = UMFMessage.createMessage(message).toJSON();
    msg.mid = `${msg.mid}-${tracer}`;

    if (this.config.debugLogging) {
      this.log(INFO, `HR: [${tracer}] Calling remote service ${Utils.safeJSONStringify(msg)}`);
    }

    hydra.makeAPIRequest(msg, {timeout: this.requestTimeout})
      .then((data) => {
        if (data.statusCode > 201) {
          this.errorStats.log(serviceName);
        }
        if (data.statusCode > 499) {
          this.log(FATAL, `HR: [${tracer}] ${serviceName} reported: HTTP:${data.statusCode}`);
        }
        if (data.headers) {
          let headers = Object.assign({
            'x-hydra-tracer': tracer
          }, data.headers);
          let ct = headers['content-type'];
          if (ct && ct.indexOf('json') > -1) {
            delete data.headers;
            data = Object.assign(data, Utils.safeJSONParse(data.payLoad));
            delete data.payLoad;
            let newPayLoad = Utils.safeJSONStringify(data);
            headers['content-length'] = Buffer.byteLength(newPayLoad);
            response.writeHead(data.statusCode, headers);
            response.write(newPayLoad);
          } else {
            response.writeHead(data.statusCode, headers);
            response.write(data.payLoad);
          }
          response.end();
        } else {
          serverResponse.sendResponse(data.statusCode, response, {
            result: {
              reason: data.result.reason
            },
            tracer
          });
        }
        resolve();
      })
      .catch((err) => {
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
      });
  }

  /**
  * @name _handleCORSReqest
  * @summary handle a CORS preflight request
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
  * @return {undefined}
  */
  _handleCORSReqest(request, response) {
    // Handle CORS preflight
    response.writeHead(ServerResponse.HTTP_OK, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'accept, authorization, cache-control, content-type, x-requested-with',
      'access-control-max-age': 10,
      'Content-Type': 'application/json'
    });
    response.end();
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

    if (matchResult.pattern === '/v1/router/list/:thing') {
      if (matchResult.params.thing === 'routes') {
        this._handleRouteListRoutes(response);
      } else if (matchResult.params.thing === 'services') {
        this._handleRouteListServices(response);
      } else if (matchResult.params.thing === 'nodes') {
        this._handleRouteListNodes(response);
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
      from: `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`,
      body: {}
    });

    if (route.apiRoute.indexOf('/v1/router/list') > -1) {
      if (route.apiRoute.indexOf('routes') > -1) {
        this._handleRouteListRoutes(null, ws, responseMessage);
      } else if (route.apiRoute.indexOf('services') > -1) {
        this._handleRouteListServices(null, ws, responseMessage);
      } else if (route.apiRoute.indexOf('nodes') > -1) {
        this._handleRouteListNodes(null, ws, responseMessage);
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
    let httpStats = this.httpStats.getStats();
    let wsStats = this.wsStats.getStats();
    let errorStats = this.errorStats.getStats();

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
  _handleRouteListServices(response, ws, responseMessage) {
    let findItemData = (space, key, instanceID) => {
      if (!space[key]) {
        return {};
      }
      return space[key].find((item) => item.instanceID === instanceID);
    };

    hydra.getServiceHealthAll()
      .then((result) => {
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
      })
      .catch((err) => {
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
      });
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
  _handleRouteListNodes(response, ws, responseMessage) {
    hydra.getServiceNodes()
      .then((nodes) => {
        if (response) {
          serverResponse.sendOk(response, {
            instanceID: hydra.getInstanceID(),
            hostname: this.hostName,
            version: hydra.getInstanceVersion(),
            result: nodes
          });
        } else {
          responseMessage.body = nodes;
          this._sendWSMessage(ws, responseMessage.toJSON());
        }
      })
      .catch((err) => {
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
      });
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
    request.on('end', () => {
      try {
        umf = UMFMessage.createMessage(Utils.safeJSONParse(umf));
      } catch (err) {
        this.log(FATAL, `HR: ${err.message}`);
        this.log(FATAL, err);
        serverResponse.sendInvalidRequest(response);
        return;
      }

      let forwardMessage = UMFMessage.createMessage({
        to: umf.forward,
        from: `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`,
        body: umf.body
      });
      hydra.makeAPIRequest(forwardMessage.toJSON(), {timeout: this.requestTimeout})
        .then((data) => {
          serverResponse.sendResponse(data.statusCode, response, {
            result: data.result
          });
        })
        .catch((err) => {
          this.log(FATAL, `HR: ${err.message}`);
          this.log(FATAL, err);
          serverResponse.sendResponse(err.statusCode, response, {
            result: {
              reason: err.message
            }
          });
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
  _clearServices(response, ws, responseMessage) {
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
    hydra.getServiceNodes()
      .then((nodes) => {
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
      })
      .catch((err) => {
        console.log(err);
        if (!response) {
          responseMessage.body = {
            error: err.message
          };
          this._sendWSMessage(ws, responseMessage.toJSON());
        }
      });
  }

  /**
  * @name _refreshRoutes
  * @summary Refresh router routes.
  * @param {string} service - if undefined then all service routes will be refreshed otherwise only the route for a specific service will be updated
  * @return {undefined}
  */
  _refreshRoutes(service) {
    hydra.getAllServiceRoutes()
      .then((routesObj) => {
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
      })
      .catch((err) => {
        this.log(FATAL, `HR: ${err.message}`);
        this.log(FATAL, err);
      });
  }
}

module.exports = new ServiceRouter();
