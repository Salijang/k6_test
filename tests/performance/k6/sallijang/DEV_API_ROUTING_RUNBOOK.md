# Sallijang Dev API Routing Runbook

작성일: 2026-05-04 KST

## Scope

- AWS profile: `salijang`
- AWS region: `ap-northeast-2`
- AWS account: `594486941613`
- EKS cluster: `pickup-dev-eks-cluster`
- Public API: `https://api.sallijang.shop`

## 2026-05-05 Rebuild Summary

dev infra를 다시 올린 뒤 현재 라우팅 상태:

- `api.sallijang.shop` Route53 alias가 ALB로 연결된다.
- ALB target group은 EKS node target을 `healthy`로 본다.
- ArgoCD Applications 5개가 `Synced` / `Healthy`다.
- `GET /health` -> `200 text/plain`
- `GET /api/v1/products/?limit=1&offset=0` -> `200 application/json`
- 인증이 필요한 API가 token 없이 `401 application/json`을 반환하면 라우팅은 정상이다.

주의:

- 현재 ALB 인증서는 `api.sallijang.shop`를 커버하지 않는다. 인증서 교체 전까지 외부 확인은 `curl -k`, k6는 `--insecure-skip-tls-verify`가 필요하다.
- nginx admission webhook과 metrics-server APIService가 timeout 나면 EKS control plane에서 node pod port로 들어오는 SG rule을 확인한다.
  - nginx admission webhook: TCP `8443`
  - metrics-server: TCP `10251`

## 2026-05-04 Incident Summary

초기 증상:

- `GET /health` -> `200 healthy`
- `GET /api/v1/products/` -> nginx `404`
- `GET /api/v1/auth/me` -> nginx `404`

판단:

- ALB, Route53, TLS, TargetGroup은 정상이다.
- ALB access log에서 `elb_status_code=404`, `target_status_code=404`가 같이 찍혔다.
- ALB target은 `10.0.x.x:30080` nginx ingress controller까지 도달했다.
- 따라서 원인은 ALB가 아니라 nginx ingress에 `/api/v1/*` 라우팅이 없거나 아직 sync되지 않은 상태다.

현재 상태:

- ArgoCD Applications:
  - `sallijang-ingress`
  - `sallijang-user`
  - `sallijang-product`
  - `sallijang-order`
  - `sallijang-notify`
- 모두 `Synced` / `Healthy`
- `GET /api/v1/products/?limit=1&offset=0` -> `200 application/json`
- 인증이 필요한 API가 token 없이 `401 application/json`을 반환하면 라우팅은 정상이다.

## Fix Applied

CHS IAM user에 EKS access entry를 추가했다.

```bash
AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 aws eks create-access-entry \
  --cluster-name pickup-dev-eks-cluster \
  --principal-arn arn:aws:iam::594486941613:user/CHS \
  --type STANDARD

AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 aws eks associate-access-policy \
  --cluster-name pickup-dev-eks-cluster \
  --principal-arn arn:aws:iam::594486941613:user/CHS \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster
```

추가로 실제 backend prefix와 ingress path가 다른 버그가 있었다.

- backend: `/api/v1/wishlists`
- manifest: `/api/v1/wishlist`

`Salijang/sallijang-manifest` upstream에 직접 push 권한이 없어서, 2026-05-04 당시 dev 클러스터에는 임시 hotfix Ingress를 적용했다.

- Resource: `default/sallijang-wishlists-hotfix`
- PR: `https://github.com/Salijang/sallijang-manifest/pull/1`

2026-05-05 dev 재생성 이후 이 cluster-only hotfix resource는 없다. PR이 merge되고 ArgoCD sync가 끝나면 별도 hotfix 없이 Git 기준 manifest만 사용한다.

```bash
AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 \
KUBECONFIG=/tmp/salijang-dev-kubeconfig \
kubectl delete ingress sallijang-wishlists-hotfix -n default
```

## Diagnosis Commands

Kubeconfig:

```bash
AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 aws eks update-kubeconfig \
  --name pickup-dev-eks-cluster \
  --kubeconfig /tmp/salijang-dev-kubeconfig \
  --alias pickup-dev-eks-cluster
```

Cluster routing state:

```bash
AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 \
KUBECONFIG=/tmp/salijang-dev-kubeconfig \
kubectl get applications.argoproj.io -A -o wide

AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 \
KUBECONFIG=/tmp/salijang-dev-kubeconfig \
kubectl get ingress,svc,endpoints,pods -n default -o wide

AWS_PROFILE=salijang AWS_REGION=ap-northeast-2 \
KUBECONFIG=/tmp/salijang-dev-kubeconfig \
kubectl describe ingress sallijang-ingress -n default
```

External checks:

```bash
curl -sk -w '\n%{http_code} %{content_type}\n' https://api.sallijang.shop/health
curl -sk -w '\n%{http_code} %{content_type}\n' 'https://api.sallijang.shop/api/v1/products/?limit=1&offset=0'
curl -sk -w '\n%{http_code} %{content_type}\n' https://api.sallijang.shop/api/v1/auth/me
curl -sk -w '\n%{http_code} %{content_type}\n' https://api.sallijang.shop/api/v1/wishlists/
```

Expected:

- `/health`: `200 text/plain`
- `/api/v1/products/`: `200 application/json`
- auth-required endpoints without cookie: `401 application/json`
- nginx `404` means ingress path did not match.

## Recovery Rules

1. If `/health` is `200` but `/api/v1/*` is nginx `404`, check ArgoCD and Ingress first.
2. If Ingress exists but backend shows no endpoints, check Deployment/Service selectors.
3. If Ingress points to a service path typo, fix `sallijang-manifest/base/ingress/ingress.yaml`.
4. Do not treat auth-required `401 application/json` as a routing failure.
5. Keep Git as source of truth. Cluster-only hotfix resources must have a removal note and matching PR.
