# SSH tunnel to the in-house map server, run as a container. The map server listens on 127.0.0.1:8095 of the
# server it runs on, so (like any other device) the OMS reaches it through the tunnel-only login "mapdev".
FROM alpine:3.20
RUN apk add --no-cache openssh-client
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8095
ENTRYPOINT ["/entrypoint.sh"]
