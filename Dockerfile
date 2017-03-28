FROM flywheelsports/servicebase:0.0.2
MAINTAINER Carlos Justiniano cjus34@gmail.com
EXPOSE 80
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
ADD . /usr/src/app
RUN npm install -g pino-elasticsearch
RUN npm install --production
ENTRYPOINT ["node", "hydra-router"]
