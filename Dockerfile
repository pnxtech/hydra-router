FROM node:8.0.0-alpine
MAINTAINER Carlos Justiniano cjus34@gmail.com
EXPOSE 80
HEALTHCHECK --start-period=10s --interval=5m --timeout=3s CMD curl -f http://localhost:80/v1/router/health || exit 1

# Performance tuning
RUN echo "net.core.somaxconn = 3072" >> /etc/sysctl.conf && \
    echo "net.ipv4.tcp_max_syn_backlog = 4096" >> /etc/sysctl.conf && \
    echo "net.ipv4.conf.default.rp_filter = 0" >> /etc/sysctl.conf && \
    echo "net.ipv4.tcp_keepalive_time = 120" >> /etc/sysctl.conf && \
    echo "fs.file-max = 2097152" >> /etc/sysctl.conf

RUN apk add --update curl && rm -rf /var/cache/apk/*
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
HEALTHCHECK --interval=5m --timeout=3s CMD curl -f http://localhost:80/v1/router/health || exit 1
ADD . /usr/src/app
RUN npm install -g pino-elasticsearch
RUN npm install --production
ENTRYPOINT ["node", "hydra-router"]
