import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const client = jwksClient({
  jwksUri: 'http://localhost:8080/realms/oms-upcl/protocol/openid-connect/certs',
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// Verifies the Bearer token on every request and attaches the decoded
// roles to req.user. Rejects with 401 if missing/invalid.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = {
      username: decoded.preferred_username,
      roles: (decoded.realm_access && decoded.realm_access.roles) || [],
    };
    next();
  });
}

// Use after requireAuth on routes that need a specific role.
export function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.some((r) => req.user.roles.includes(r))) {
      return res.status(403).json({ error: 'Insufficient role' });
    }
    next();
  };
}
