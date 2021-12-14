'use strict';

const hydra = require('hydra');

/**
 * @name WebSocketPlugin
 * @description On websocket connections this plugin can be activated
 * to handle connections which supply a username:password in the
 * following format: ws://user:password@address.com:5353/ws
 *
 * A hydra-enabled microservice (auth-service) is expected to be
 * present to handle an HTTP POST call asking to validate a user.
 *
 *
 * To utilize this websocket authentication plugin the following three
 * keys need to be present in the hydra-router config file.
 *
 * "requireWebsocketAuth": true,
 * "websocketAuthService": "auth-v1-svcs",
 * "websocketAuthServiceAPI": "v1/auth/websocket",
 *
 */
class WebSocketPlugin {
  /**
   * @name init
   * @summary initization
   * @param {object} config - configuration object
   * @return undefined
   */
   init(config) {
    this.config = config;
  }

  /**
   * @name authenticate
   * @summary Call authentication service or method
   * @param {string} key
   * @returns {promise} resolves to result of service HTTP call
   */
  authenticate(key) {
    return hydra.makeAPIRequest({
      to: `${this.config.websocketAuthService}:[post]/${this.config.websocketAuthServiceAPI}`,
      from: `hydra-router`,
      body: {
        key
      }
    });
  }
};

module.exports = WebSocketPlugin;
