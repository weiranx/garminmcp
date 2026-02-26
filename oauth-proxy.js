const express = require('express')
const { createProxyMiddleware } = require('http-proxy-middleware')
const crypto = require('crypto')
const { spawn } = require('child_process')

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const CLIENT_ID = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
const SUPERGATEWAY_PORT = 8100

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: CLIENT_ID and CLIENT_SECRET must be set')
  process.exit(1)
}

// Start supergateway as a child process
const gateway = spawn('supergateway', [
  '--stdio',
  'uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp',
  '--outputTransport', 'streamableHttp',
  '--port', String(SUPERGATEWAY_PORT)
], {
  env: { ...process.env, HOME: '/root' },
  shell: true
})

gateway.stdout.on('data', (data) => process.stdout.write(`[supergateway] ${data}`))
gateway.stderr.on('data', (data) => process.stderr.write(`[supergateway] ${data}`))
gateway.on('exit', (code) => {
  console.error(`[supergateway] exited with code ${code}`)
  process.exit(1)
})

// Wait for supergateway to be ready
const waitForGateway = () => new Promise((resolve) => setTimeout(resolve, 3000))

// In-memory token store
const tokens = new Map()

// OAuth token endpoint
app.post('/oauth/token', (req, res) => {
  const { grant_type, client_id, client_secret } = req.body

  if (
    grant_type !== 'client_credentials' ||
    client_id !== CLIENT_ID ||
    client_secret !== CLIENT_SECRET
  ) {
    return res.status(401).json({ error: 'invalid_client' })
  }

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = Date.now() + 3600 * 1000
  tokens.set(token, expiresAt)

  // Clean up expired tokens
  for (const [t, exp] of tokens.entries()) {
    if (Date.now() > exp) tokens.delete(t)
  }

  res.json({
    access_token: token,
    token_type: 'bearer',
    expires_in: 3600
  })
})

// Auth middleware
const authenticate = (req, res, next) => {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const token = auth.slice(7)
  const expiresAt = tokens.get(token)
  if (!expiresAt || Date.now() > expiresAt) {
    tokens.delete(token)
    return res.status(401).json({ error: 'invalid_token' })
  }
  next()
}

// Health check (no auth needed)
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Protected MCP proxy
app.use('/mcp', authenticate, createProxyMiddleware({
  target: `http://localhost:${SUPERGATEWAY_PORT}`,
  changeOrigin: true
}))

// Start server after supergateway is ready
waitForGateway().then(() => {
  app.listen(8101, () => {
    console.log('[oauth-proxy] Listening on port 8101')
    console.log('[oauth-proxy] Token endpoint: POST /oauth/token')
    console.log('[oauth-proxy] MCP endpoint: /mcp (bearer token required)')
  })
})
