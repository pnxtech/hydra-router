exports.value = {
  appServiceName: 'hydra-router',
  cluster: false,
  environment: 'development',
  maxSockets: 500,
  logPath: '',
  hydra: {
    serviceName: 'hydra-router',
    serviceInstanceID: 34,
    serviceIP: '127.0.0.1',
    servicePort: 0,
    serviceType: 'router',
    aws: {
      accessKeyId: '',
      secretAccessKey: '',
      region: 'us-west-1',
      apiVersions: {
        cloudsearch: '2013-01-01',
        ses: '2010-12-01',
        sqs: '2012-11-05',
        s3: '2006-03-01'
      }
    },
    redis: {
      url: '127.0.0.1',
      port: 6379
    }
  }
};
