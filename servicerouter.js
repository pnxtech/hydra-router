'use strict';

const Promise = require('bluebird');
const hydra = require('fwsp-hydra');
const ServerResponse = require('fwsp-server-response');
const serverResponse = new ServerResponse;
const Utils = require('fwsp-jsutils');
const UMFMessage = require('fwsp-umf-message');
const url = require('url');
const querystring = require('querystring');
const Route = require('route-parser');
const version = require('./package.json').version;
const serverRequest = require('request');
const Queuer = require('fwsp-queuer');

let wsClients = {};

/**
* @name ServiceRouter
* @description A module which uses Hydra to route service requests.
*/
class ServiceRouter {
  constructor() {
    this.routerTable = null;
    this.serviceNames = {};
    this.appLogger = null;
    serverResponse.enableCORS(true);
    this._handleIncomingChannelMessage = this._handleIncomingChannelMessage.bind(this);
  }

  /*
  * @name init
  * @summary Initialize the service router using a route object.
  * @param {object} config - configuration
  * @param {object} routesObj - routes object
  */
  init(config, routesObj, appLogger) {
    this.appLogger = appLogger;
    Object.keys(routesObj).forEach((serviceName) => {
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
      routesObj[serviceName] = newRouteItems;
    });
    hydra.on('message', this._handleIncomingChannelMessage);

    this.queuer = new Queuer();
    this.queuer.open(config.queuer);

    this.routerTable = routesObj;
    this._refreshRoutes();
  }

  /**
  * @name _sendWSMessage
  * @summary send websocket message in short UMF format
  * @param {object} ws - websocket
  * @param {object} message - umf formatted message
  */
  _sendWSMessage(ws, message) {
    let msg = UMFMessage.createMessage(message);
    ws.send(Utils.safeJSONStringify(msg.toShort()));
  }

  /**
  * @name _handleIncomingChannelMessage
  * @summary Handle incoming UMF messages from other services
  * @param {object} msg - UMF formated message
  */
  _handleIncomingChannelMessage(msg) {
    let message = UMFMessage.createMessage(msg);
    if (message.body.action === 'refresh') {
      this._refreshRoutes(message.body.serviceName);
      return;
    }
    if (message.via) {
      let viaRoute = UMFMessage.parseRoute(message.via);
      if (viaRoute.subID) {
        let ws = wsClients[viaRoute.subID];
        if (ws) {
          delete msg.via;
          this._sendWSMessage(ws, msg);
        } else {
          // websocket not found - it was likely closed, so queue the message for later retrieval
          this.queuer.enqueue(`hydra-router:message:queue:${viaRoute.subID}`, msg);
        }
      }
    }
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
        let matchTest = routeEntry.route.match(urlData.path);
        if (matchTest) {
          return {
            serviceName,
            params: matchTest,
            pattern: routeEntry.pattern
          };
        }
      }
    }
    this.appLogger.info(`${urlData.path} was not matched to a route`);
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
    return new Promise((resolve, reject) => {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        // allow-headers below are in lowercase per: https://nodejs.org/api/http.html#http_message_headers
        response.writeHead(ServerResponse.HTTP_OK, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': 'accept, authorization, cache-control, content-type, x-requested-with',
          'access-control-max-age': 10,
          'Content-Type': 'application/json'
        });
        response.end();
        return;
      }

      let requestUrl = request.url;

      if (requestUrl[requestUrl.length-1] === '/') {
        response.writeHead(302, {
          'Location': requestUrl.substring(0, requestUrl.length - 1)
        });
        response.end();
        return;
      }

      let urlData = url.parse(`http://${request.headers['host']}${requestUrl}`);

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

      if (!matchResult) {
        let segs = urlData.path.split('/');
        if (this.serviceNames[segs[1]]) {
          matchResult = {
            serviceName: segs[1]
          };
          segs.splice(1,1);
          requestUrl = segs.join('/');
          if (requestUrl === '/') {
            requestUrl = '';
          }
        }
      }

      if (matchResult) {
        if (matchResult.serviceName === hydra.getServiceName()) {
          this._handleRouterRequest(matchResult, request, response);
          resolve();
          return;
        }

        if (request.method === 'POST' || request.method === 'PUT') {
          let body = '';
          request.on('data', (data) => {
            body += data;
          });
          request.on('end', () => {
            let message = UMFMessage.createMessage({
              to: `${matchResult.serviceName}:[${request.method.toLowerCase()}]${requestUrl}`,
              from: `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`,
              body: Utils.safeJSONParse(body)
            });
            if (request.headers['authorization']) {
              message.authorization = request.headers['authorization'];
            }
            hydra.makeAPIRequest(message.toJSON())
              .then((data) => {
                serverResponse.sendResponse(data.statusCode, response, data);
                resolve();
              })
              .catch((err) => {
                this.appLogger.fatal(err);
                let reason;
                if (err.result && err.result.reason) {
                  reason = err.result.reason;
                } else {
                  reason = err.message;
                }
                serverResponse.sendResponse(err.statusCode, response, {
                  result: {
                    reason
                  }
                });
                resolve();
              });
          });
        } else {
          /**
          * Route non POST and PUT message types.
          */

          // if request isn't a JSON request then locate an service instance and passthrough the request in plain HTTP
          if (request.headers['content-type'] !== 'application/json') {
            hydra.getServicePresence(matchResult.serviceName)
              .then((presenceInfo) => {
                if (presenceInfo.length > 0) {
                  let idx = Math.floor(Math.random() * presenceInfo.length);
                  let presence = presenceInfo[idx];

                  let segs = requestUrl.split('/');
                  if (segs[1] === matchResult.serviceName) {
                    requestUrl = '';
                  }

                  let url = `http://${presence.ip}:${presence.port}${requestUrl}`;
                  let options = {
                    uri: url,
                    method: request.method,
                    headers: request.headers
                  };
                  serverRequest(options, (error, response, body) => {
                    if (error) {
                      if (error.code === 'ECONNREFUSED') {
                        // caller is no longer available.
                      }
                    }
                  }).pipe(response);
                } else {
                  let msg = `Unavailable ${matchResult.serviceName} instances`;
                  serverResponse.sendResponse(ServerResponse.HTTP_SERVICE_UNAVAILABLE, response, {
                    result: {
                      reason: msg
                    }
                  });
                  this.appLogger.fatal(msg);
                }
              });
            return;
          }

          // this is a JSON request, package should contain a UMF message.
          let message = {
            to: `${matchResult.serviceName}:[${request.method.toLowerCase()}]${requestUrl}`,
            from: `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`,
            body: {}
          };
          if (request.headers['authorization']) {
            message.authorization = request.headers['authorization'];
          }
          let msg = UMFMessage.createMessage(message).toJSON();
          hydra.makeAPIRequest(msg)
            .then((data) => {
              if (data.headers) {
                let headers = {
                  'Content-Type': data.headers['content-type'],
                  'Content-Length': data.headers['content-length']
                };
                response.writeHead(ServerResponse.HTTP_OK, headers);
                response.write(data.body);
                response.end();
              } else {
                if (data.statusCode) {
                  serverResponse.sendResponse(data.statusCode, response, {
                    result: data.result
                  });
                } else if (data.code) {
                  serverResponse.sendResponse(data.code, response, {
                    result: {}
                  });
                } else {
                  serverResponse.sendResponse(serverResponse.HTTP_NOT_FOUND, response, {
                    result: {}
                  });
                }
              }
              resolve();
            })
            .catch((err) => {
              let msg = err.result.reason;
              serverResponse.sendResponse(err.statusCode, response, {
                result: {
                  reason: msg
                }
              });
              this.appLogger.fatal(err);
              resolve();
            });
        }
      } else {
        serverResponse.sendNotFound(response);
        resolve();
      }
    });
  }

  /**
  * @name wsRouteThroughHttp
  * @summary Route websocket request throuigh HTTP
  * @param {object} ws - websocket
  * @param {object} message - UMF message
  */
  wsRouteThroughHttp(ws, message) {
    let longMessage = UMFMessage.createMessage(message);
    let replyMessage = UMFMessage.createMessage({
      to: longMessage.from,
      from: longMessage.to,
      rmid: longMessage.mid,
      body: {}
    });

    hydra.makeAPIRequest(longMessage.toJSON())
      .then((data) => {
        replyMessage.body = {
          result: data.result
        };
        this._sendWSMessage(ws, replyMessage.toJSON());
      })
      .catch((err) => {
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
        this.appLogger.fatal(err);
      });
  }

  /**
  * @name sendConnectMessage
  * @summary Send a message on socket connect
  * @param {object} ws - websocket
  * @param {number} id - connection id if any
  */
  sendConnectMessage(ws, id) {
    ws.id = id || Utils.shortID();
    if (!wsClients[ws.id]) {
      wsClients[ws.id] = ws;
    }
    let welcomeMessage = UMFMessage.createMessage({
      to: `${ws.id}@client:/`,
      from: `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`,
      type: 'connection',
      body: {
        id: ws.id
      }
    });
    this._sendWSMessage(ws, welcomeMessage.toJSON());
  }

  /**
  * @name routeWSMessage
  * @summary Route a websocket message
  * @param {object} ws - websocket
  * @param {string} message - UMF message in string format
  */
  routeWSMessage(ws, message) {
    let umf = UMFMessage.createMessage({
      'to': `client-${ws.id}:/`,
      'from': `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`
    });
    let premsg = Utils.safeJSONParse(message);
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

    if (msg.to.indexOf('[') > -1 && msg.to.indexOf(']') > -1) {
      // does route point to an HTTP method? If so, route through HTTP
      // i.e. [get] [post] etc...
      this.wsRouteThroughHttp(ws, msg.toJSON());
    } else {
      switch (msg.type) {
        case 'ping':
          let newMsg = UMFMessage.createMessage({
            to: msg.from,
            rmid: msg.mid,
            body: {
              typ: 'pong'
            }
          });
          this._sendWSMessage(ws, newMsg.toJSON());
          return;
        case 'reconnect':
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
            this.sendConnectMessage(ws, msg.body.id);
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
              umf.body = {
                error: `No ${toRoute.serviceName} instances available`
              };
              this._sendWSMessage(ws, umf.toJSON());
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
            hydra.sendMessage(newMsg.toJSON());
          });
      }
    }
  }

  /**
  * @name wsDisconnect
  * @summary handle websocket disconnect
  * @param {object} ws - websocket
  */
  wsDisconnect(ws) {
    ws.close();
    delete wsClients[ws.id];
  }

  /**
  * @name _handleRouterRequest
  * @summary Handles requests intended for this router service.
  * @private
  * @param {object} matchResult - route match results
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
  */
  _handleRouterRequest(matchResult, request, response) {
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
    } else if (matchResult.pattern.indexOf('/v1/router/refresh') > -1) {
      this._refreshRoutes(matchResult.params.service);
      serverResponse.sendOk(response);
    } else if (matchResult.pattern.indexOf('/v1/router/version') > -1) {
      this._handleRouteVersion(response);
    } else if (matchResult.pattern.indexOf('/v1/router/message') > -1) {
      this._handleMessage(request, response);
    } else {
      serverResponse.sendNotFound(response);
    }
  }

  /**
  * @name _handleRouteVersion
  * @summary Handle list routes requests. /v1/router/version.
  * @private
  * @param {object} response - Node HTTP response object
  */
  _handleRouteVersion(response) {
    serverResponse.sendOk(response, {
      result: {
        version
      }
    });
  }

  /**
  * @name _handleRouteListRoutes
  * @summary Handle list routes requests. /v1/router/list/routes.
  * @private
  * @param {object} response - Node HTTP response object
  */
  _handleRouteListRoutes(response) {
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
    serverResponse.sendOk(response, {
      result: routeList
    });
  }

  /**
  * @name _handleRouteListServices
  * @summary Handle list services requests. /v1/router/list/services.
  * @private
  * @param {object} response - Node HTTP response object
  */
  _handleRouteListServices(response) {
    let findItemData = (space, key, instanceID) => {
      if (!space[key]) {
        return {};
      }
      return space[key].find(item => item.instanceID === instanceID);
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
              if (service.log.length > 3) {
                service.log.length = 3;
              }
              serviceInstanceData.log = service.log;
            }
            serviceInstanceDataItems.push(serviceInstanceData);
          });
        });
        serverResponse.sendOk(response, {
          result: serviceInstanceDataItems
        });
      })
      .catch((err) => {
        serverResponse.sendServerError(response, {
          result: {
            reason: err.message
          }
        });
      });
  }

  /**
  * @name _handleRouteListNodes
  * @summary Handle request to list nodes
  * @private
  * @param {object} response - Node HTTP response object
  */
  _handleRouteListNodes(response) {
    hydra.getServiceNodes()
      .then((nodes) => {
        serverResponse.sendOk(response, {
          result: nodes
        });
      })
      .catch((err) => {
        serverResponse.sendServerError(response, {
          result: {
            reason: err.message
          }
        });
      });
  }

  /**
  * @name _handleMessage
  * @summary Route incoming UMF message.
  * @private
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
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
        serverResponse.sendInvalidRequest(response);
        return;
      }

      let forwardMessage = UMFMessage.createMessage({
        to: umf.forward,
        from: `${hydra.getInstanceID()}@${hydra.getServiceName()}:/`,
        body: umf.body
      });
      hydra.makeAPIRequest(forwardMessage.toJSON())
        .then((data) => {
          serverResponse.sendResponse(data.statusCode, response, {
            result: data.result
          });
        })
        .catch((err) => {
          serverResponse.sendResponse(err.statusCode, response, {
            result: {
              reason: data.result.reason
            }
          });
        });
    });
  }

  /**
  * @name _refreshRoutes
  * @summary Refresh router routes.
  * @param {string} service - if undefined then all service routes will be refreshed otherwise only the route for a specific service will be updated
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
            [`/${serviceName}`, `/${serviceName}/`, `/${serviceName}/:rest`].forEach((pattern) => {
              newRouteItems.push({
                pattern: pattern,
                route: new Route(pattern)
              });
            });
            this.routerTable[serviceName] = newRouteItems;
          }
        });
      });
  }
}

module.exports = new ServiceRouter();
