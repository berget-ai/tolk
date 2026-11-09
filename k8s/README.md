# tolk k8s-manifest (berget-dmz)

QR-kodsbaserad live-captioning + översättning (Berget AI realtime-transkribering,
Gemma-översättning, System One för styckebrytning, sherpa-onnx för
talarbyten/talstreck). Publik på **https://tolk.berget.ai**.

Den här katalogen är appens deploymanifest i app-repot (samma mönster som
julrim m.fl.): Flux i berget-dmz hämtar repot via `GitRepository "tolk"`
(se `clusters/berget-dmz/apps/tolk/` i [infra-repot](https://github.com/berget-ai/infra))
och applicerar innehållet via Kustomization med `prune: true`.

- **Kluster**: berget-dmz, namespace `tolk` (namespace.yaml ägs av infra)
- **Ingress**: Envoy Gateway (`gatewayClassName: eg`) + HTTPRoute +
  cert-manager (`letsencrypt-prod`), enligt firecrawl/netbird-mönstret
- **Secrets**: OpenBao via Vault Secrets Operator (`secret/tolk/app`)
- **Websockets**: långlivade — `ClientTrafficPolicy streamIdleTimeout: 0s` +
  24h request-timeout är obligatoriska (annars reaps efter ~300 s)

## Automatic deploys (Flux image automation)

1. Push till main → GitHub Actions-bygget (`docker.yaml`) pushar
   `ghcr.io/berget-ai/tolk:latest` + `:<version>` (version ur package.json).
2. `ImageRepository "tolk"` skannar ghcr var 5:e minut.
3. `ImagePolicy "tolk"` väljer senaste semver-taggen (>=0.1.0; `latest`- och
   sha-taggar ignoreras).
4. `ImageUpdateAutomation "tolk"` committar tagghöjningen till den här
   katalogens `deployment.yaml` (markern `{"$imagepolicy": "flux-system:tolk"}`
   på image-raden) som `fluxcdbot`.
5. Flux synkar och rullar podden (rollout, preStop ger WS:erna 5 s att avsluta).

Skriv aldrig över image-taggen manuellt – automationen äger den. Engångs-forecering
utan ny tagg:

```bash
flux -n flux-system reconcile image repository tolk
flux -n flux-system reconcile image update tolk
flux reconcile kustomization tolk --with-source
```

## Engångsåtgärder (setup 2026-10/11)

### 1. Vault: roll + policy + nyckel — **redan gjort 2026-10-11**

Utfördes mot OpenBao i berget-prod (wejay-mönstret):

```bash
bao write auth/kubernetes-berget-dmz/role/tolk \
  bound_service_account_names=vault-client \
  bound_service_account_namespaces=tolk \
  policies=tolk \
  ttl=24h

bao policy write tolk - <<EOF
path "secret/data/tolk/app" {
  capabilities = ["read"]
}
EOF

bao kv put secret/tolk/app \
  BERGET_API_KEY="sk_ber_..."
```

### 2. GHCR-paketet är publikt

`ghcr.io/berget-ai/tolk` är publikt (ärver repots synlighet) — anonym pull
fungerar, **inget regcred behövs**. Om paketet någon gång görs privat: lägg
till `imagePullSecrets: [regcred]` i deployment.yaml igen och skapa secreten.

### 3. Deploy key för image automation — **redan gjort 2026-11-09**

`flux-berget-dmz-tolk` (edge: skrivbar) ligger som deploy key på repot; den
privata nyckeln ligger som secret `tolk-git` i namespace `flux-system` i
berget-dmz och används av `GitRepository/ImageUpdateAutomation "tolk"`.

### 4. DNS: tolk.berget.ai

external-dns på dmz hanterar bara `dmz.berget.ai`, `r8s.berget.ai` och
`berget.cloud` (rfc2136 mot ns1.getgeek.se) — **inte** hela `berget.ai`.
Därför får Gateway-LB:n sitt A-record automatiskt som
`tolk.dmz.berget.ai` (annotation i gateway.yaml), och det publika namnet
kopplas manuellt (samma som wejay.org):

```
CNAME tolk.berget.ai → tolk.dmz.berget.ai   (manuellt, engångssteg)
```

### 5. IPPool: ledig LB-slot

Varje per-app-Gateway får en LoadBalancer-IP ur IPPoolen `berget`
(194.145.172.8–.49). Poolen var nästan full 2026-09-28 — verifiera ledigt
slot **innan** merge av en ny gateway:

```bash
kubectl get svc -A | grep envoy
```

## Verifiering

```bash
curl -sf https://tolk.berget.ai/healthz        # över HTTPS
kubectl -n tolk logs deploy/tolk | tail
flux -n flux-system get images policy,repository,automation
```

Sedan: skapa en session på webbplatsen, starta en sändning (kräver HTTPS för
mikrofon), skanna QR-koden och håll en lyssnarsida öppen > 5 min (bevisar att
streamIdleTimeout-policyn fungerar).

## Kända begränsningar

- Sessioner är in-memory i podden — därför `replicas: 1`. En publik lyssnares
  `GET /api/sessions/:id` skapar tillståndet i samma pod som tar emot
  `/ws/listen`, men bara så länge det inte roterar mellan replikor. Ifall
  trafiken någon gång kräver horisontell skalning: antingen
  `sessionPersistence` (GEP-1619) på HTTPRoute:n, eller en delad
  sessionsstore (Redis) i appen. En pod-restart pågående event tappar
  historiken oavsett (sessionsobjekten är flyktiga) – däremot återanvänds
  rumskoderna (lat återskapande, se README "Reusable room codes").
- Utegående trafik: poden måste nå `api.berget.ai` (HTTPS + WSS) — dmz-egress,
  inga NetworkPolicies definierade just nu.
