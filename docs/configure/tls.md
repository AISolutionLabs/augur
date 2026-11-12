# TLS and internal CAs

Internal gateways (LiteLLM in your cluster, an internal MCP server) are often signed by a company CA that Grafana pods don't trust. Add that CA instead of turning off verification.

Augur trusts the CAs you add **in addition to** the system roots, for both the model endpoint and MCP servers, so public endpoints keep working.

## Option 1: a CA bundle file (recommended on Kubernetes)

Mount the bundle into the Grafana pod and point the datasource at it:

```yaml title="Helm values"
extraConfigmapMounts:
  - name: internal-ca
    configMap: internal-ca        # contains ca.pem
    mountPath: /etc/ssl/internal
    readOnly: true
```

```yaml title="Datasource"
jsonData:
  tlsCACertFile: /etc/ssl/internal/ca.pem
```

The file is read when the datasource loads. After rotating the CA, save the datasource again or restart Grafana.

## Option 2: paste the certificate

In the datasource editor, turn on **Add CA certificate** and paste the PEM (it can contain several certificates). It's stored encrypted.

```yaml
jsonData:
  tlsAuthWithCACert: true
secureJsonData:
  tlsCACert: |
    -----BEGIN CERTIFICATE-----
    ...
    -----END CERTIFICATE-----
```

## Skip verification

`tlsSkipVerify: true` is available for testing but not recommended: it lets anyone on the network path read prompts, telemetry and credentials.

## Checking it

**Save & test** reports an unreadable or invalid CA (`CA certificate: …`). An `x509: certificate signed by unknown authority` error means the endpoint's chain isn't covered by the system roots or your CA. Check that the bundle includes the issuing intermediate or root:

```bash
openssl s_client -connect litellm.example.internal:443 -showcerts </dev/null
```

## Zscaler and TLS-inspecting proxies

If outbound traffic goes through a TLS-inspecting proxy, add the proxy's root CA the same way, and make sure Grafana uses the proxy (`HTTPS_PROXY` on the Grafana container). The datasource honours the standard proxy environment variables.
