'use strict';

require('./helpers/chai.js');
const request = require('superagent');

// const config = require('./properties').value;
const version = require('../package.json').version;
const hydraRouter = require('../hydra-router.js');
