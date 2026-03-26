#!/usr/bin/env node
import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
if (proxyUrl) {
  // Patch the global HTTPS agent so gaxios/googleapis routes through the proxy
  https.globalAgent = new HttpsProxyAgent(proxyUrl)
}

import { runMain } from 'citty'
import { createProgram } from './command.js'

const program = await createProgram()
runMain(program)
