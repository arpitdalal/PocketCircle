const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const kid = crypto.randomUUID();
const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

console.log(
  `MCP_WORKER_SIGNING_PRIVATE_JWK=${JSON.stringify({ ...privateJwk, kid, alg: "ES256" })}`,
);
console.log(
  `MCP_WORKER_VERIFYING_JWKS=${JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "ES256" }] })}`,
);
