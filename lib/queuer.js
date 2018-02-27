'use strict';

const Promise = require('bluebird');
const hydra = require('hydra');
const Utils = hydra.getUtilsHelper();

/**
* @name Queuer
* @summary message queuer
* @return {undefined}
*/
class Queuer {
  /**
  * @name constructor
  * @summary class constructor
  * @return {undefined}
  */
  constructor() {
    this.config = null;
    this.db = null;
  }

  /**
  * @name init
  * @summary set redisclient
  * @param {object} redisclient - cloned redis client
  * @param {number} dbNum - redis database number
  * @param {number} defaultQueueExpiration - default queue experation in seconds
  * @return {promise} promise - returns a promise
  * @return {undefined}
  */
  init(redisclient, dbNum, defaultQueueExpiration) {
    this.db = redisclient;
    this.dbNum = dbNum;
    this.expiration = defaultQueueExpiration || 86400; // 24 hours in seconds
    return new Promise((resolve, reject) => {
      this.db.select(dbNum, (err, _reply) => {
        (err) ? reject(err) : resolve(this.db);
      });
    });
  }

  /**
  * @name close
  * @summary close Redis db
  * @return {undefined}
  */
  close() {
    this.db.quit();
    this.db = null;
  }

  /**
  * @name enqueue
  * @summary Push a job into a job queue
  * @param {string} queueName - name of queue to use
  * @param {object} obj - object which will be queued
  * @return {promise} promise - returns a promise
  */
  enqueue(queueName, obj) {
    return new Promise((resolve, reject) => {
      let js = Utils.safeJSONStringify(obj);
      if (!js) {
        reject(new Error('unable to stringify object'));
        return;
      }
      this.db.rpush(`${queueName}:queued`, js, (err, data) => {
        if (err) {
          reject(err);
        } else {
          this.db.expire(`${queueName}:queued`, this.expiration);
          resolve(data);
        }
      });
    });
  }

  /**
  * @name dequeue
  * @summary Removes a job from the job queue and moves it into the in-processing queue
  * @param {string} queueName - name of queue to use
  * @return {promise} promise - returns a promise resolving to the dequeued job.
  */
  dequeue(queueName) {
    return new Promise((resolve, reject) => {
      this.db.rpoplpush(`${queueName}:queued`, `${queueName}:processing`, (err, data) => {
        if (err) {
          reject(err);
        } else {
          this.db.expire(`${queueName}:queued`, this.expiration);
          resolve(Utils.safeJSONParse(data));
        }
      });
    });
  }

  /**
  * @name complete
  * @summary mark an obj as completed, by removing it from the in-processing queue
  * @param {string} queueName - name of queue to use
  * @param {object} obj - obj which will be marked as completed
  * @return {promise} promise - returns a promise resolving to the completed job.
  */
  complete(queueName, obj) {
    return new Promise((resolve, reject) => {
      this.db.lrem(`${queueName}:processing`, -1, Utils.safeJSONStringify(obj), (err, data) => {
        if (err) {
          reject(err);
        } else {
          this.db.expire(`${queueName}:processing`, this.expiration);
          resolve(Utils.safeJSONParse(data));
        }
      });
    });
  }
}

module.exports = Queuer;
