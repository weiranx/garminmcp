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
const BASE_URL = process.env.BASE_URL // e.g. https://garmin.weiranxiong.com

if (!CLIENT_ID || !CLIENT_SECRET || !BASE_URL) {
  console.error('ERROR: CLIENT_ID, CLIENT_SECRET, and BASE_URL must be set')
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

// In-memory stores
const authCodes = new Map()   // code -> { redirectUri, codeChallenge, expiresAt }
const tokens = new Map()      // token -> expiresAt

// Helper: base64url encode
const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

// Helper: verify PKCE code challenge
const verifyPKCE = (verifier, challenge) => {
  const hash = crypto.createHash('sha256').update(verifier).digest()
  return base64url(hash) === challenge
}

// ── OAuth Discovery endpoint ──────────────────────────────────────────────────
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256']
  })
})

// ── Authorization endpoint ────────────────────────────────────────────────────
app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.query

  if (response_type !== 'code') {
    return res.status(400).send('Unsupported response_type')
  }

  if (client_id !== CLIENT_ID) {
    return res.status(401).send('Invalid client_id')
  }

  if (code_challenge_method && code_challenge_method !== 'S256') {
    return res.status(400).send('Only S256 code_challenge_method supported')
  }

  // Show a simple approval page
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Authorize Garmin MCP</title>
      <style>
        body { font-family: sans-serif; max-width: 400px; margin: 80px auto; padding: 20px; }
        h2 { margin-bottom: 8px; }
        p { color: #555; margin-bottom: 24px; }
        .btn { display: inline-block; padding: 10px 24px; border-radius: 6px; border: none; cursor: pointer; font-size: 15px; }
        .approve { background: #2563eb; color: white; margin-right: 8px; }
        .deny { background: #e5e7eb; color: #333; }
      </style>
    </head>
    <body>
      <h2>Authorize Garmin MCP</h2>
      <p>Claude is requesting access to your Garmin fitness data.</p>
      <form method="POST" action="/authorize">
        <input type="hidden" name="client_id" value="${client_id}" />
        <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
        <input type="hidden" name="code_challenge" value="${code_challenge || ''}" />
        <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ''}" />
        <input type="hidden" name="state" value="${state || ''}" />
        <input type="hidden" name="scope" value="${scope || ''}" />
        <button type="submit" name="action" value="approve" class="btn approve">Approve</button>
        <button type="submit" name="action" value="deny" class="btn deny">Deny</button>
      </form>
    </body>
    </html>
  `)
})

// ── Authorization POST (user clicked approve/deny) ────────────────────────────
app.post('/authorize', (req, res) => {
  const { action, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.body

  if (action !== 'approve') {
    const url = new URL(redirect_uri)
    url.searchParams.set('error', 'access_denied')
    if (state) url.searchParams.set('state', state)
    return res.redirect(url.toString())
  }

  if (client_id !== CLIENT_ID) {
    return res.status(401).send('Invalid client_id')
  }

  // Generate auth code
  const code = base64url(crypto.randomBytes(32))
  authCodes.set(code, {
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
  })

  const url = new URL(redirect_uri)
  url.searchParams.set('code', code)
  if (state) url.searchParams.set('state', state)
  res.redirect(url.toString())
})

// ── Token endpoint ────────────────────────────────────────────────────────────
app.post('/oauth/token', (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } = req.body

  // Client credentials flow (fallback)
  if (grant_type === 'client_credentials') {
    if (client_id !== CLIENT_ID || client_secret !== CLIENT_SECRET) {
      return res.status(401).json({ error: 'invalid_client' })
    }
    const token = base64url(crypto.randomBytes(32))
    tokens.set(token, Date.now() + 3600 * 1000)
    return res.json({ access_token: token, token_type: 'bearer', expires_in: 3600 })
  }

  // Authorization code flow
  if (grant_type === 'authorization_code') {
    if (client_id !== CLIENT_ID) {
      return res.status(401).json({ error: 'invalid_client' })
    }

    const stored = authCodes.get(code)
    if (!stored || Date.now() > stored.expiresAt) {
      return res.status(400).json({ error: 'invalid_grant' })
    }

    if (stored.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
    }

    // Verify PKCE if present
    if (stored.codeChallenge && code_verifier) {
      if (!verifyPKCE(code_verifier, stored.codeChallenge)) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' })
      }
    }

    authCodes.delete(code)

    const token = base64url(crypto.randomBytes(32))
    tokens.set(token, Date.now() + 3600 * 1000)

    // Clean up expired tokens
    for (const [t, exp] of tokens.entries()) {
      if (Date.now() > exp) tokens.delete(t)
    }

    return res.json({ access_token: token, token_type: 'bearer', expires_in: 3600 })
  }

  res.status(400).json({ error: 'unsupported_grant_type' })
})

// ── Auth middleware ───────────────────────────────────────────────────────────
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// ── Protected MCP proxy ───────────────────────────────────────────────────────
app.use('/mcp', authenticate, createProxyMiddleware({
  target: `http://localhost:${SUPERGATEWAY_PORT}`,
  changeOrigin: true
}))

// ── Start ─────────────────────────────────────────────────────────────────────
const waitForGateway = () => new Promise((resolve) => setTimeout(resolve, 3000))

waitForGateway().then(() => {
  app.listen(8101, () => {
    console.log('[oauth-proxy] Listening on port 8101')
    console.log(`[oauth-proxy] Authorize: ${BASE_URL}/authorize`)
    console.log(`[oauth-proxy] Token:     ${BASE_URL}/oauth/token`)
    console.log(`[oauth-proxy] MCP:       ${BASE_URL}/mcp`)
  })
})
