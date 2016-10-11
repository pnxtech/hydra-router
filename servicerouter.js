'use strict';

const Promise = require('bluebird');
const hydra = require('@flywheelsports/fwsp-hydra');
const ServerResponse = require('fwsp-server-response');
const serverResponse = new ServerResponse;
const Utils = require('fwsp-jsutils');
const UMFMessage = require('fwsp-umf-message');
const url = require('url');
const querystring = require('querystring');
const Route = require('route-parser');
const version = require('./package.json').version;

let wsClients = {};

/**
* @name ServiceRouter
* @description A module which uses Hydra to route service requests.
*/
class ServiceRouter {
  constructor() {
    this.routerTable = null;
    serverResponse.enableCORS(true);
    this._handleIncomingChannelMessage = this._handleIncomingChannelMessage.bind(this);
  }

  /*
  * @name init
  * @summary Initialize the service router using a route object.
  * @param {object} config - configuration
  * @param {object} routesObj - routes object
  */
  init(config, routesObj) {
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
    this.routerTable = routesObj;
    hydra.on('message', this._handleIncomingChannelMessage);
  }

  /**
  * @name _handleIncomingChannelMessage
  * @summary Handle incoming UMF messages from other services
  * @param {object} message - UMF formated message
  */
  _handleIncomingChannelMessage(message) {
    if (message.body.action === 'refresh') {
      this._refreshRoutes(message.body.serviceName);
      return;
    }
    if (message.via) {
      let viaRoute = UMFMessage.parseRoute(message.via);
      if (viaRoute.subID) {
        let ws = wsClients[viaRoute.subID];
        if (ws) {
          delete message.via;
          ws.send(Utils.safeJSONStringify(message));
        } else {
          // websocket not found - it was likely closed
          //TODO(CJ): figure out what to do with message replies for closed sockets
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

      // console.log('Request: ', request.url);
      // console.log('  method:', request.method);
      // console.log('  headers:', request.headers);

      let urlData = url.parse(`http://${request.headers['host']}${request.url}`);
      let matchResult = this._matchRoute(urlData);
      if (matchResult) {
        if (matchResult.serviceName === 'hydra-router') {
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
            let message = hydra.createUMFMessage({
              to: `${matchResult.serviceName}:[${request.method.toLowerCase()}]${request.url}`,
              from: 'hydra-router:/',
              body: Utils.safeJSONParse(body)
            });
            if (request.headers['authorization']) {
              message.authorization = request.headers['authorization'];
            }
            hydra.makeAPIRequest(message)
              .then((data) => {
                serverResponse.sendResponse(data.statusCode, response, {
                  result: data.result
                });
                resolve();
              })
              .catch((err) => {
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
          let message = {
            to: `${matchResult.serviceName}:[${request.method.toLowerCase()}]${request.url}`,
            from: 'hydra-router:/',
            body: {}
          };
          if (request.headers['authorization']) {
            message.authorization = request.headers['authorization'];
          }
          hydra.makeAPIRequest(hydra.createUMFMessage(message))
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
                serverResponse.sendResponse(data.statusCode, response, {
                  result: data.result
                });
              }
              resolve();
            })
            .catch((err) => {
              console.log('err', err);
              serverResponse.sendResponse(err.statusCode, response, {
                result: {
                  reason: err.result.reason
                }
              });
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
    let longMessage = UMFMessage.messageToLong(message);
    let replyMessage = UMFMessage.createMessage({
      to: longMessage.from,
      from: longMessage.to,
      rmid: longMessage.mid,
      body: {}
    });

    hydra.makeAPIRequest(message)
      .then((data) => {
        replyMessage.body = {
          result: data.result
        };
        ws.send(Utils.safeJSONStringify(replyMessage));
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
        ws.send(Utils.safeJSONStringify(replyMessage));
      });
  }

  /**
  * @name markSocket
  * @summary Tags a websocket with an ID
  * @param {object} ws - websocket
  */
  markSocket(ws) {
    ws.id = Utils.shortID();
    if (!wsClients[ws.id]) {
      wsClients[ws.id] = ws;
    }
  }

  /**
  * @name routeWSMessage
  * @summary Route a websocket message
  * @param {object} ws - websocket
  * @param {string} message - UMF message in string format
  */
  routeWSMessage(ws, message) {
    let msg;
    let umf = UMFMessage.createMessage({
      'to': 'client:/',
      'from': 'hydra-router:/'
    });

    msg = Utils.safeJSONParse(message);
    if (!msg) {
      umf.body = {
        error: `Unable to parse: ${message}`
      };
      ws.send(Utils.safeJSONStringify(umf));
      return;
    }

    if (!UMFMessage.validateMessage(msg)) {
      umf.body = {
        error: 'Message is not a valid UMF message'
      };
      ws.send(Utils.safeJSONStringify(umf));
      return;
    }

    msg = UMFMessage.createMessage(msg);

    if (msg.to.indexOf('[') > -1 && msg.to.indexOf(']') > -1) {
      // does to route point to an HTTP method? If so, route through HTTP
      // i.e. [get] [post] etc...
      this.wsRouteThroughHttp(ws, msg);
    } else {
      let toRoute = UMFMessage.parseRoute(msg.to);
      if (toRoute.instance !== '') {
        let viaRoute = `${hydra.getInstanceID()}-${ws.id}@${hydra.getServiceName()}:/`;
        let newMessage = Object.assign(msg, {
          via: viaRoute,
          frm: msg.from
        });
        hydra.sendMessage(newMessage);
      } else {
        hydra.getServicePresence(toRoute.serviceName)
          .then((results) => {
            let toRoute = UMFMessage.parseRoute(msg.to);
            hydra.sendMessage(UMFMessage.createMessage({
              to: `${results[0].instanceID}@${results[0].serviceName}:${toRoute.apiRoute}`,
              via: `${hydra.getInstanceID()}-${ws.id}@${hydra.getServiceName()}:/`,
              bdy: msg.body,
              frm: msg.from
            }, true));
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
    let umfMessage = '';
    request.on('data', (data) => {
      umfMessage += data;
    });
    request.on('end', () => {
      try {
        umfMessage = Utils.safeJSONParse(umfMessage);
      } catch (err) {
        console.log(err);
        serverResponse.sendInvalidRequest(response);
        return;
      }

      let forwardMessage = hydra.createUMFMessage({
        to: umfMessage.forward,
        from: 'hydra-router:/',
        body: umfMessage.body
      });
      hydra.makeAPIRequest(forwardMessage)
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
      });
  }
}

module.exports = new ServiceRouter();
