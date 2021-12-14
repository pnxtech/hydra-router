'use strict';

const Promise = require('bluebird');
const hydra = require('hydra');
const Utils = hydra.getUtilsHelper();

class HTTPPlugin {

  /**
   * @name init
   * @summary initization
   * @param {object} config - configuration object
   * @return undefined
   */
  init(config) {
    this.config = config;
  }


};

module.exports = HTTPPlugin;
