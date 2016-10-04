'use strict';

const Promise = require('bluebird');
const redis = require('redis');
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
    this._connectToRedis(config.hydra);
    this.redisdb.select(config.hydra.redis.db, (err, result) => {});

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
   * @name _connectToRedis
   * @summary Configure access to redis and monitor emitted events.
   * @private
   * @param {object} config - redis client configuration
   */
  _connectToRedis(config) {
    let redisConfig = Object.assign({
      maxReconnectionPeriod: 60,
      maxDelayBetweenReconnections: 5
    }, config);

    try {
      let redisOptions = {
        retry_strategy: (options) => {
          if (options.total_retry_time > (1000 * redisConfig.maxReconnectionPeriod)) {
            hydra.sendToHealthLog('error', 'Max redis connection retry period exceeded.');
            process.exit(-10);
            return;
          }
          // reconnect after
          let reconnectionDelay = Math.floor(Math.random() * redisConfig.maxDelayBetweenReconnections * 1000) + 1000;
          return reconnectionDelay;
        }
      };
      this.redisdb = redis.createClient(redisConfig.redis.port, redisConfig.redis.url, redisOptions);
      this.redisdb
        .on('connect', () => {
          hydra.sendToHealthLog('info', 'Successfully reconnected to redis server');
          this.redisdb.select(redisConfig.redis.db);
        })
        .on('reconnecting', () => {
          hydra.sendToHealthLog('error', 'Reconnecting to redis server...');
        })
        .on('warning', (warning) => {
          hydra.sendToHealthLog('error', `Redis warning: ${warning}`);
        })
        .on('end', () => {
          hydra.sendToHealthLog('error', 'Established Redis server connection has closed');
        })
        .on('error', (err) => {
          hydra.sendToHealthLog('error', `Redis error: ${err}`);
        });
    } catch (e) {
      hydra.sendToHealthLog('error', `Redis error: ${e.message}`);
    }
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
  * @param {object} message - UMF message
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

    // let fromRoute = UMFMessage.parseRoute(msg.from);
    // if (!wsClients[fromRoute.serviceName]) {
    //   wsClients[fromRoute.serviceName] = ws;
    // }
    //
    // // push message onto service queue
    // msg['for'] = fromRoute.serviceName;
    // msg.from = 'hydra-router:/';
    // hydra.queueMessage(msg);
    //
    // // notify service of new queued message
    // let toRoute = UMFMessage.parseRoute(msg.to);
    // hydra.sendMessage(toRoute.serviceName, hydra.createUMFMessage({
    //   to: msg.to,
    //   from: msg.from,
    //   body: {
    //     event: 'new:queued:message',
    //     mid: msg.mid
    //   }
    // }));

    let toRoute = UMFMessage.parseRoute(msg.to);
    if (toRoute.instance !== '') {
      // message directed to a service instance
      let viaRoute = `${hydra.getInstanceID()}-${ws.id}@${hydra.getServiceName()}:/`;
      let channel = `${results[0].serviceName}:${results[0].instanceID}`;
      let newMessage = Object.assign(msg, {
        via: viaRoute
      });
      hydra.openPublisherChannel(channel);
      hydra.publishToChannel(channel, newMessage);
    } else {
      // message can be sent to any available instance
      hydra.getServicePresence(toRoute.serviceName)
        .then((results) => {
          let toRoute = UMFMessage.parseRoute(msg.to);
          let newToRoute = `${results[0].instanceID}@${results[0].serviceName}:${toRoute.apiRoute}`;
          let viaRoute = `${hydra.getInstanceID()}-${ws.id}@${hydra.getServiceName()}:/`;
          let channel = `${results[0].serviceName}:${results[0].instanceID}`;
          let newMessage = Object.assign(msg, {
            to: newToRoute,
            from: msg.from,
            via: viaRoute
          });
          hydra.openPublisherChannel(channel);
          hydra.publishToChannel(channel, newMessage);
        });
    }
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
    } else if (matchResult.pattern.indexOf('/v1/router/aws-webhook') > -1) {
      this._handleAWSWebhook(request, response);
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
  * @name _handleAWSWebhook
  * @summary Handles incoming messages from AWS SNS.
  * @private
  * @param {object} request - Node HTTP request object
  * @param {object} response - Node HTTP response object
  */
  _handleAWSWebhook(request, response) {
    let payload = '';
    request.on('data', (data) => {
      payload += data;
    });
    request.on('end', () => {
      try {
        payload = Utils.safeJSONParse(payload);
      } catch (err) {
        console.log(err);
        serverResponse.sendInvalidRequest(response);
        return;
      }

      if (payload.Type && payload.TopicArn) {
        // if Payload Type and TopicArn fields exists then this is likely an AWS message
        let topicSegments = payload.TopicArn.split(':');
        let eventChannelName = topicSegments[5];
        console.log(`Incoming ${eventChannelName} message via AWS SNS`);

        if (payload.Type === 'SubscriptionConfirmation') {
          serverResponse.sendOk(response);
          let eventSegments = eventChannelName.split('_');
          hydra.confirmSubscriptionToEventChannel(eventSegments[0], eventSegments[1], payload.Token)
            .then((result) => {
              // console.log(result);
            })
            .catch((err) => {
              console.log('err', err);
            });
        } else if (payload.Type === 'Notification') {
          try {
            let message = Utils.safeJSONParse(payload.Message);
            console.log('Message Body:', message);
            hydra.makeAPIRequest(message);
          } catch (err) {
            console.log(err);
          } finally {
            serverResponse.sendOk(response);
          }
        }
      } else {
        serverResponse.sendOk(response);
      }
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
