![logo](hydra-router.png)

Hydra Router is a service-aware router which can direct HTTP and WebSocket message requests to registered services. It was was announced at EmpireNode 2016.
If you'd like to learn more about Hydra visit the [github repo](https://github.com/flywheelsports/hydra) for a list of articles and videos.

---

## Introduction

Using HydraRouter external clients can connect to services without knowing their IP or port information. HydraRouter takes care of service discovery and routing.

Additionally, HydraRouter can route to a website being hosted by a service.  If the router is accessed using a service name as the first url path segment and the request is an HTTP GET call, then the request is routed to an available service instance.

When more than one service instance exists for a type of service, requests made through the HydraRouter are load balanced among available instances.

Hydra router also exposes a RESTful endpoint which can be used to query service health and presence information.  

Using Hydra microservices can locate one another using functions such as [findService](https://github.com/flywheelsports/hydra#findservice), [sendServiceMessage](https://github.com/flywheelsports/hydra#sendservicemessage) and [makeAPIRequest](https://github.com/flywheelsports/hydra#makeapirequest). This all works quite well without the need for DNS, or a service router.

However, when remote API requests arrive into the cloud infrastructure, determining how to **flexibly** route requests intended for upstream services becomes problematic. Consider that services may launch using different IPs and or random ports. To handle these requirements one approach involves the use of DNS, Elastic Load Balancers, and Elastic IPs. One still has to manage the machines attached to each load balancer and running multiple services on a machine further complicates the situation.

This is where Dynamic Service Registries and Routers come into play. They're designed to simplify the above requirements by being services-aware and performing intelligent routing.

Hydra-Router, using Hydra, implements a Dynamic Service Registry and Router. To do so, it uses the route information that Hydra-enabled services publishes during their start-up and initialization phase. It then routes incoming messages directly to services regardless of the following challenges:

* There may be one or more service instances available to handle a specific request.
* Services might come and go, each time starting with a different IP address or port.
* Service routes might change (updated or removed), as services are added or improved.
* No changes to infrastructure would be required to address the above concerns.

So how does this work?

As noted earlier, during startup, [Hydra](https://github.com/flywheelsports/hydra) services perform automated registration. That's done behind the scenes when the [hydra.registerService](https://github.com/flywheelsports/hydra/blob/master/README.md#registerservice) method is called. When building services using [Hydra-Express](https://github.com/flywheelsports/hydra-express), the service's routes can be registered automatically during the initialization phase.

```javascript
hydraExpress.init(config, version, () => {
  hydraExpress.registerRoutes({
    '/v1/offers': require('./offers-v1-api')
  });
});
```

The HydraRouter then uses the resulting service registration information to later route messages to specific services.

Services can be started on any machine on a network with or without the use of random IP ports. Because each service registers itself - it can be located by a HydraRouter. That's the Dynamic Service Registry bit.

> But is it really a router? Yes! Hydra-Router uses [route-parser]() an AST-based tree parser for matching routes.

When a message is sent to the HydraRouter it checks whether the request matches a registered route. If so, the request message is routed to an active instance of the service which registered the route. When multiple service instances exist for a service, Hydra-Router will load-balance the requests to spread the load among available services.

> ☕ **A key takeaway here is that this happens automatically without the need to update configuration and infrastructure. This works using Hydra's built-in service discovery and routing functionality.**

## Message Gateway
In addition to routing plain-old HTTP messages to their designated services, HydraRouter exposes an HTTP endpoint for other incoming messages.

```
/v1/router/message
```

Messages are expected to be in the [UMF message format](https://github.com/cjus/umf) and are thus routable to other microservices within a network.

## Website traffic passthrough

Hydra-router is able to route site requests to microservices. So a microservice can serve a website in addition to responding to RESTful API calls and processing messages. This feature isn't intended for high traffic usage scenarios. Rather, this feature is intended for admin pages, status pages and other low-traffic situations. While images and other binary assets can be served - it's recommended that you use a CDN to offload requests for common static assets.

The benefits of using this feature is that you may launch services on dynamic ports on arbitrary IP's and leverage the router to find individual service instances. In this way, website requests can be handled by multiple load balanced service instances.

## HTTP proxy passthrough
HydraRouter allows you to specify routes to non-hydra services. Essentially this allows external clients to make API requests through hydra to backend servers.

To enable this functionality, simply define externals routes under the `externalRoutes` key in the configuration file. The `externalRoutes` key consists of an object of urls and their array of routes.

```javascript
:
'externalRoutes': {
  'https://someotherservice.com': [
    '[post]/api/v2/token/create',
    '[get]/api/v2/user/self.json'
  ]
},
:
```

## WebSockets

The Hydra-Router supports WebSocket connections. However, it only accepts stringified [UMF](https://github.com/cjus/umf) formatted messages.

```javascript
let ws = new WebSocket('ws://127.0.0.1:5353');
ws.on('open', () => {
  let msg = {
    'to': 'a-hydra-service:/',
    'version': 'UMF/1.4.3',
    'from': 'tester:/',
    'mid': '4736ef3d-fcbb-46aa-80a0-f4f3493e1d74',
    'timestamp': '2017-01-12T20:16:29.157Z',
    'body': {}
  };
  ws.send(JSON.stringify(msg));
});
```

### WebSocket reconnection and messaging

Hydra-Router supports queuing messages intended for your WebSocket client should your client's WebSocket connection break. Your client only needs to reconnect and issues a reconnection message to begin receiving earlier messages.

Upon an initial connection your WebSocket client will receive a message that looks a bit like this:

```javascript
{
  "to": "2945p8eigxz@client:/",
  "frm": "c274b25909aee5cbec2857361f425fa7@hydra-router:/",
  "mid": "dffc2949-0e2a-4417-8f28-46addb5fc716",
  "ts": "2017-01-12T19:31:54.831Z",
  "typ": "connection",
  "ver": "UMF/1.4.3",
  "bdy": {
    "id": "2945p8eigxz"
  }
}
```

The `bdy.id` value is the WebSocket session ID.  If your client dies and needs to reconnect it can issue a reconnection message such as:

```javascript
{
  "to": "hydra-router:/",
  "frm": "client:/",
  "mid": "e173a0da-2785-4f83-8b39-0dea954dd91b",
  "typ": "reconnection",
  "ver": "UMF/1.4.3",
  "bdy": {
    "id": "2945p8eigxz"
  }
}
```

There are three things to note above. First the message is sent to the `hydra-router` which manages the actual WebSocket connections. Secondarily, the `bdy.id` is the same as the WebSocket session ID that the client had before it crashed or lost its connection.
Thirdly, we use a message type (typ) of "reconnection".

Upon receiving a message like that, Hydra-Router will load queued messages (if any) and begin sending them to your newly connected client.

## What happens when a service changes its routes?
Great question! When a service is launched, in addition to registering itself and publishing its routes, it also broadcast a message to all Hydra-Router services so they can update their route information for the newly updated service. This is done on a per service basis so other service routes remain unaffected.

## What if a service instance is unavailable?
If an active instance of a service can't be found then Hydra-Router will reply with a standard HTTP 503 (HTTP_SERVICE_UNAVAILABLE) error.

## So what's the catch?
HydraRouter can only be used with Hydra-enabled services and can only route JSON message payloads.  However, the most common HTTP verbs are supported so you can send GET, POST, DELETE and PUT requests.

## Optional Router API

Hydra-Router offers an HTTP API in order to expose the routes and services it's working with. This is completely optional and intended for use in debugging and monitoring scenarios.

**Router version: /v1/router/version**

Query the version of the Hydra-Router.

```shell
$ curl -X 'GET' 'http://localhost:8000/v1/router/version'
```

Response:

```javascript
{
  'status': 200,
  'statusText': 'Success',
  'result': {
    'version': '1.0.0'
  }
}
```

**Listing routes: /v1/router/list/routes**

Used to display a list of registered routes.  Notice that the Hydra-Router, itself a service, display's its own API.

```javascript
{
  'status': 200,
  'statusText': 'Success',
  'result': [
    {
      'serviceName': 'hydra-router',
      'routes': [
        '/v1/router/version',
        '/v1/router/refresh',
        '/v1/router/list/:thing',
        '/v1/router/message',
        '/v1/router/refresh/:service'
      ]
    },
    {
      'serviceName': 'red-service',
      'routes': [
        '/v1/red/hello',
        '/v1/red/say'
      ]
    },
    {
      'serviceName': 'blue-service',
      'routes': [
        '/v1/blue/hello',
        '/v1/blue/say'
      ]
    }
  ]
}
```

**Listing services: /v1/router/list/services**

Displays active services instances. Here we see service presence information including data points such as health and uptime. If a service crashes it would no longer appear in the response.

```javascript
{
  'status': 200,
  'statusText': 'Success',
  'result': [
    {
      'serviceName': 'blue-service',
      'instanceID': 'bd579b2384701aba617af40c0ff75580',
      'updatedOn': '2016-05-22T00:21:11.908Z',
      'processID': 51947,
      'ip': '127.0.0.1',
      'port': 3686,
      'sampledOn': '2016-05-22T00:21:11.908Z',
      'architecture': 'x64',
      'platform': 'darwin',
      'nodeVersion': 'v4.2.4',
      'memory': {
        'rss': 28045312,
        'heapTotal': 31148896,
        'heapUsed': 26754472
      },
      'uptime': '2 minutes, 7.358 seconds',
      'usedDiskSpace': '82%',
      'log': []
    },
    {
      'serviceName': 'hydra-router',
      'instanceID': '4d5831c3de6feb69a6b150946753065c',
      'updatedOn': '2016-05-22T00:21:11.103Z',
      'processID': 51755,
      'ip': '127.0.0.1',
      'port': 8000,
      'sampledOn': '2016-05-22T00:21:11.103Z',
      'architecture': 'x64',
      'platform': 'darwin',
      'nodeVersion': 'v4.2.4',
      'memory': {
        'rss': 27168768,
        'heapTotal': 18740576,
        'heapUsed': 17638920
      },
      'uptime': '3 minutes, 2.337 seconds',
      'usedDiskSpace': '82%',
      'log': [
        {
          'ts': '2016-05-22T00:18:10.383Z',
          'serviceName': 'hydra-router',
          'type': 'info',
          'processID': 51755,
          'message': 'Starting hydra-router service hydra-router on port 8000'
        }
      ]
    },
    {
      'serviceName': 'red-service',
      'instanceID': 'a3e9a88912b49238e7254ef3cec2e4cd',
      'updatedOn': '2016-05-22T00:21:09.766Z',
      'processID': 51759,
      'ip': '127.0.0.1',
      'port': 1185,
      'sampledOn': '2016-05-22T00:21:09.767Z',
      'architecture': 'x64',
      'platform': 'darwin',
      'nodeVersion': 'v4.2.4',
      'memory': {
        'rss': 30908416,
        'heapTotal': 31148896,
        'heapUsed': 27060712
      },
      'uptime': '2 minutes, 47.579 seconds',
      'usedDiskSpace': '82%',
      'log': [
      ]
    }
  ]
}
```

**Listing nodes: /v1/router/list/nodes**

The list nodes request display nodes (instance of a service) which may or may not be present. This call differs from the /list/services call in that inactive instances are displayed.

```shell
$ curl -X 'GET' 'http://localhost:8000/v1/router/nodes'
```

```javascript
{
  'statusCode': 200,
  'statusMessage': 'OK',
  'statusDescription': 'Request succeeded without error',
  'result': [
    {
      'serviceName': 'music',
      'serviceDescription': 'Music service',
      'version': '0.0.9',
      'instanceID': '07eb06f8f8b346a78704a5d9e672a780',
      'updatedOn': '2016-07-27T19:38:28.773Z',
      'processID': 2209,
      'ip': '10.1.1.176',
      'port': 5000,
      'elapsed': 2
    },
    {
      'serviceName': 'hydra-router',
      'serviceDescription': 'Service Router',
      'version': '1.1.1',
      'instanceID': 'ecf72192389ff6212bf88da03802adc9',
      'updatedOn': '2016-07-27T19:38:29.705Z',
      'processID': 2864,
      'ip': '10.1.1.176',
      'port': 5353,
      'elapsed': 1
    },
    {
      'serviceName': 'auth-service',
      'serviceDescription': 'Authentication service',
      'version': '0.0.10',
      'instanceID': '5b3ade39a70aba675223edc46d8c710c',
      'updatedOn': '2016-07-27T19:38:13.371Z',
      'processID': 2487,
      'ip': '10.1.1.176',
      'port': 1337,
      'elapsed': 17
    }
  ]
}
```


**Route Refresh: /v1/router/refresh/:service**

Automatically used by hydra-enabled web services when they come online.

**Example Route passthrough**

An example of sending a message through the Hydra-Router to a service called `red-service`:

```shell
$ curl -X 'GET' 'http://localhost:8000/v1/red/hello'
```

Response:

```javascript
{
  'code': 200,
  'result': {
    'message': 'Hello from red-service'
  }
}
```

You might have noticed a slight inconsistency in the response above.  Earlier examples display `status`, `statusText` and `result` JSON fields. The above example does not! The reason is because Hydra-Router returns the exact (untranslated) server response sent from the service endpoint.

### Securing the router API

The router API is exposed by default. In production deployments you'll likely what to either disable or restrict access to the router API.  You can do this by defining two keys in the config.json file:

```javascript
"disableRouterEndpoint": false,
"routerToken": "",
```

If `disableRouterEndpoint` is set to `true` then access to the router API will be disabled and callers will receive an HTTP 404 response. If enabled, then access to the router API depends on the value of `routerToken`. If the token is blank then access is allowed - if a value is present it must be a [UUIDv4](https://en.wikipedia.org/wiki/Universally_unique_identifier) token.

```javascript
"disableRouterEndpoint": false,
"routerToken": "098ebe18-7e1b-4ddd-ae2a-cc6521e5b641",
```

> The dashes and segments sizes are significant and validated using a regular expression.

The Hydra-Router will search for the presence of the token as query string parameters.

```
http://localhost:5353/v1/router/list/routes?token=098ebe18-7e1b-4ddd-ae2a-cc6521e5b641
```
