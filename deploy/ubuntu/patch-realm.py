#!/usr/bin/env python3
"""Write infra/keycloak-realm.deploy.json: the shipped realm, with the oms-web login allowed to return to this server.
Usage: patch-realm.py <host>"""
import json, sys
host = sys.argv[1]
src, dst = "infra/keycloak-realm.json", "infra/keycloak-realm.deploy.json"
realm = json.load(open(src, encoding="utf-8"))
for c in realm["clients"]:
    if c["clientId"] == "oms-web":
        c["redirectUris"] = [f"https://{host}:8443/*", f"http://{host}:8080/*", "http://localhost:15173/*"]
        c["webOrigins"] = [f"https://{host}:8443", f"http://{host}:8080", "http://localhost:15173"]
json.dump(realm, open(dst, "w", encoding="utf-8"), indent=2)
print(f"realm patched for {host}")
