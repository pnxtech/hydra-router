#!/usr/bin/env node

'use strict';

const program = require('commander');
const version = require('./package.json').version;

class WSSend {
  main() {
    program
      .version(version)
      .description('WS Send Message command line client')
      .command('api', 'issue an API call')
      .parse(process.argv);
  }
}

(new WSSend).main();
