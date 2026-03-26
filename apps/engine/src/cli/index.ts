#!/usr/bin/env node
import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
if (proxyUrl) {
  // Patch the global HTTPS agent so gaxios/googleapis routes through the proxy.
  // The engine's only outbound HTTPS targets are external APIs (Stripe, Google) so
  // this does not incorrectly proxy internal traffic. The Stripe SDK is scoped
  // separately via an explicit httpClient in makeClient(). If NO_PROXY support is
  // needed in future, replace with a per-host agent or proxy-from-env.
  https.globalAgent = new HttpsProxyAgent(proxyUrl)
}

import { runMain } from 'citty'
import { createProgram } from './command.js'

const program = await createProgram()
runMain(program)
