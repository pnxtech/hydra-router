exports.value = {
  appServiceName: 'hydra-router',
  cluster: false,
  environment: 'development',
  maxSockets: 500,
  logPath: '',
  hydra: {
    serviceName: 'hydra-router',
    serviceDescription: 'Service Router',
    serviceIP: '127.0.0.1',
    servicePort: 0,
    serviceType: 'router',
    redis: {
      url: '127.0.0.1',
      port: 6379,
      db: 15
    }
  }
};
