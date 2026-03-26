ARG SMOKESCREEN_VERSION=v0.0.4

FROM golang:1.23 AS builder
WORKDIR /app
RUN git clone --depth 1 --branch ${SMOKESCREEN_VERSION} https://github.com/stripe/smokescreen.git .
RUN CGO_ENABLED=0 GOOS=linux go build -o smokescreen -ldflags="-s -w" .

FROM alpine:3.19
RUN apk add --no-cache netcat-openbsd
COPY --from=builder /app/smokescreen /usr/local/bin/smokescreen
ENTRYPOINT ["smokescreen"]
