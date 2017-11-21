'use strict';

const ONE_SECOND = 1;
const ONE_MINUTE = ONE_SECOND * 60;
const ONE_QUARTER_HOUR = ONE_MINUTE * 15;
const ONE_HOUR = ONE_QUARTER_HOUR * 4;

/**
* @name Stats
* @summary stats tracker
* @return {undefined}
*/
class Stats {
  /**
  * @name constructor
  * @summary class constructor
  * @return {undefined}
  */
  constructor() {
    this.stats = {};
    this.cellVisit = new Array(ONE_HOUR).fill(0);
  }

  /**
  * @name _getSecond
  * @summary get the clock second
  * @return {number} current second on the hour
  */
  _getSecond() {
    let d = new Date();
    return (d.getMinutes() * 60) + d.getSeconds();
  }

  /**
  * @name _ensureEntry
  * @summary ensure an entry exists for a service
  * @param {string} target - target path / service
  * @return {undefined}
  */
  _ensureEntry(target) {
    if (!this.stats[target]) {
      this.stats[target] = new Array(ONE_HOUR).fill(0);
    }
  }

  /**
  * @name log
  * @summary log a request
  * @param {string} target - target path / service
  * @return {undefined}
  */
  log(target) {
    this._ensureEntry(target);
    let second = this._getSecond();

    if (second === 0 && this.cellVisit[second] === 1) {
      for (let i = 0; i < ONE_HOUR; i += 1) {
        this.cellVisit[i] = 0;
      }
      this.stats[target][second] = 0;
    }

    if (this.cellVisit[second] === 0) {
      this.cellVisit[second] = 1;
      this.stats[target][second] = 1;
    } else {
      this.stats[target][second]++;
    }
  }

  /**
  * @name getStats
  * @summary retrieve stats
  * @return {object} stats - object with keys and stats data
  */
  getStats() {
    let second = this._getSecond();
    let snapshot = {};
    Object.keys(this.stats).forEach((key) => {
      snapshot[key] = this.stats[key].slice(-(ONE_HOUR - second)).concat(this.stats[key].slice(0, second)).join(',');
    });
    return snapshot;
  }

  /**
  * @name getRawStats
  * @summary retrieve raw stats
  * @return {object} stats - object with keys and stats data
  */
  getRawStats() {
    let second = this._getSecond();
    let snapshot = {};
    Object.keys(this.stats).forEach((key) => {
      snapshot[key] = this.stats[key].slice(-(ONE_HOUR - second)).concat(this.stats[key].slice(0, second));
    });
    return snapshot;
  }

  /**
  * @name getLastSecond
  * @summary tally last second of data
  * @param {array} data - dataset from getRawStats key
  * @return {undefined}
  */
  getLastSecond(data) {
    return data.slice(-ONE_SECOND);
  }

  /**
  * @name getLastMinute
  * @summary tally last minute of data
  * @param {array} data - dataset from getRawStats key
  * @return {undefined}
  */
  getLastMinute(data) {
    return data.slice(-ONE_MINUTE).reduce((sum, x) => sum + x);
  }

  /**
  * @name getLast5Minutes
  * @summary tally last five minutes of data
  * @param {array} data - dataset from getRawStats key
  * @return {undefined}
  */
  getLast5Minutes(data) {
    return data.slice(-(ONE_MINUTE * 5)).reduce((sum, x) => sum + x);
  }

  /**
  * @name getLast15Minutes
  * @summary tally last 15 minutes of data
  * @param {array} data - dataset from getRawStats key
  * @return {undefined}
  */
  getLast15Minutes(data) {
    return data.slice(-(ONE_QUARTER_HOUR)).reduce((sum, x) => sum + x);
  }

  /**
  * @name getLast30Minutes
  * @summary tally last 30 minutes of data
  * @param {array} data - dataset from getRawStats key
  * @return {undefined}
  */
  getLast30Minutes(data) {
    return data.slice(-(ONE_QUARTER_HOUR * 2)).reduce((sum, x) => sum + x);
  }

  /**
  * @name getLastHour
  * @summary tally last hour of data
  * @param {array} data - dataset from getRawStats key
  * @return {undefined}
  */
  getLastHour(data) {
    return data.reduce((sum, x) => sum + x);
  }
}

module.exports = Stats;
